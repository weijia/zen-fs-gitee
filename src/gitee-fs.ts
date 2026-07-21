import { withErrno } from 'kerium';
import { IndexFS, Index, Inode } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/constants';
import type { CreationOptions, InodeLike } from '@zenfs/core';
import { GiteeAPI, type GiteeTreeItem } from './gitee-api.js';
import type { GiteeOptions } from './types.js';

/**
 * A ZenFS backend for Gitee repositories.
 *
 * Implements the `FileSystem` interface by mapping file operations
 * to the Gitee REST API v5.
 */
export class GiteeFS extends IndexFS {
	readonly api: GiteeAPI;
	/** Maps file paths to their blob SHA (needed for updates/deletes). */
	readonly shaCache = new Map<string, string>();
	/** In-memory content cache to support synchronous reads. */
	readonly contentCache = new Map<string, Uint8Array>();
	/** Serializes async background operations. */
	private pending = Promise.resolve();
	private options: GiteeOptions;
	private initialized = false;

	constructor(options: GiteeOptions) {
		super(0x6769746565, 'gitee', new Index());
		this.options = options;
		this.api = new GiteeAPI(options);
	}

	/**
	 * Queue an async operation to run after all previous ones finish.
	 * Used by sync methods to trigger background writes/deletes.
	 */
	private _queue(p: Promise<void>): void {
		this.pending = this.pending.then(() => p).catch(() => {});
	}

	/**
	 * Initialize the file system by loading the repository tree.
	 * If the configured branch does not exist, it will be created from 'master'.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		let tree: GiteeTreeItem[] = [];
		try {
			tree = await this.api.getTree(true);
		} catch (err: any) {
			const msg = err.message || '';
			// Branch not found — try to create it
			if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
				console.log(`[GiteeFS] Branch '${this.options.branch}' not found, attempting to create...`);
				await this.api.createBranch(this.options.branch || 'master', 'master');
				// Retry loading tree
				tree = await this.api.getTree(true);
			} else {
				throw err;
			}
		}

		for (const item of tree) {
			const path = '/' + item.path;
			const id = this.index._alloc();
			const isDir = item.type === 'tree';
			const inode = new Inode({
				ino: id,
				data: id + 1,
				mode: isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644,
				size: item.size || 0,
				uid: 0,
				gid: 0,
				nlink: 1,
				atimeMs: Date.now(),
				mtimeMs: Date.now(),
				ctimeMs: Date.now(),
				birthtimeMs: Date.now(),
			});
			this.index.set(path, inode);
			if (!isDir) {
				this.shaCache.set(path, item.sha);
			}
		}

		// Ensure root directory exists
		if (!this.index.has('/')) {
			const id = this.index._alloc();
			this.index.set(
				'/',
				new Inode({
					ino: id,
					data: id + 1,
					mode: S_IFDIR | 0o755,
					size: 0,
					uid: 0,
					gid: 0,
					nlink: 1,
					atimeMs: Date.now(),
					mtimeMs: Date.now(),
					ctimeMs: Date.now(),
					birthtimeMs: Date.now(),
				})
			);
		}

		this.initialized = true;
	}

	/**
	 * Preload all file contents into memory cache.
	 * This enables synchronous reads.
	 */
	async preloadContents(): Promise<void> {
		for (const [path, node] of this.index) {
			if ((node.mode & S_IFREG) !== S_IFREG) continue;
			if (this.contentCache.has(path)) continue;
			try {
				const data = new Uint8Array(await this.api.getRaw(path));
				this.contentCache.set(path, data);
			} catch {
				// Ignore preload errors for individual files
			}
		}
	}

	async ready(): Promise<void> {
		if (!this.initialized) {
			await this.init();
			if (!this.options.disableAsyncCache) {
				await this.preloadContents();
			}
		}
	}

	readySync(): void {
		if (!this.initialized) {
			throw withErrno('EAGAIN', 'GiteeFS is not initialized');
		}
	}

	// --- Remove ---

	async remove(path: string): Promise<void> {
		const sha = this.shaCache.get(path);
		if (sha) {
			await this.api.deleteFile(path, sha, `Delete ${path}`);
			this.shaCache.delete(path);
		}
		this.contentCache.delete(path);
	}

	removeSync(path: string): void {
		const sha = this.shaCache.get(path);
		if (sha) {
			this._queue(
				this.api
					.deleteFile(path, sha, `Delete ${path}`)
					.then(() => {
						this.shaCache.delete(path);
					})
					.catch(() => {})
			);
		}
		this.contentCache.delete(path);
	}

	// --- Read ---

	async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
		if (end - start <= 0) return;
		let data = this.contentCache.get(path);
		if (!data) {
			data = new Uint8Array(await this.api.getRaw(path));
			this.contentCache.set(path, data);
		}
		const length = Math.min(end - start, data.length - start, buffer.length);
		if (length > 0) {
			buffer.set(data.subarray(start, start + length));
		}
	}

	readSync(path: string, buffer: Uint8Array, start: number, end: number): void {
		if (end - start <= 0) return;
		const data = this.contentCache.get(path);
		if (!data) {
			this._queue(this.read(path, new Uint8Array(0), 0, 0).catch(() => {}));
			throw withErrno('EAGAIN', 'File content not cached, use async read instead');
		}
		const length = Math.min(end - start, data.length - start, buffer.length);
		if (length > 0) {
			buffer.set(data.subarray(start, start + length));
		}
	}

	// --- Write ---

	async write(path: string, data: Uint8Array, offset: number): Promise<void> {
		let existing = this.contentCache.get(path) || new Uint8Array(0);
		const newSize = Math.max(existing.length, offset + data.length);
		const merged = new Uint8Array(newSize);
		merged.set(existing);
		merged.set(data, offset);
		this.contentCache.set(path, merged);

		const inode = this.index.get(path);
		if (inode) {
			inode.update({ mtimeMs: Date.now(), size: merged.length });
		}

		const sha = this.shaCache.get(path);
		if (sha) {
			const newSha = await this.api.updateFile(path, merged, sha, `Update ${path}`);
			this.shaCache.set(path, newSha);
		} else {
			const newSha = await this.api.createFile(path, merged, `Create ${path}`);
			this.shaCache.set(path, newSha);
		}
	}

	writeSync(path: string, data: Uint8Array, offset: number): void {
		let existing = this.contentCache.get(path) || new Uint8Array(0);
		const newSize = Math.max(existing.length, offset + data.length);
		const merged = new Uint8Array(newSize);
		merged.set(existing);
		merged.set(data, offset);
		this.contentCache.set(path, merged);

		const inode = this.index.get(path);
		if (inode) {
			inode.update({ mtimeMs: Date.now(), size: merged.length });
		}

		const sha = this.shaCache.get(path);
		this._queue(
			(sha
				? this.api.updateFile(path, merged, sha, `Update ${path}`)
				: this.api.createFile(path, merged, `Create ${path}`)
			)
				.then((newSha) => {
					this.shaCache.set(path, newSha);
				})
				.catch(() => {})
		);
	}

	// --- Sync ---

	async sync(): Promise<void> {
		await this.pending;
	}

	syncSync(): void {
		// Background ops are fire-and-forget; nothing to do synchronously
	}
}
