import { withErrno } from 'kerium';
import { IndexFS, Index, Inode } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/constants';
import type { CreationOptions, InodeLike } from '@zenfs/core';
import { GiteeAPI, type GiteeTreeItem } from './gitee-api.js';
import type { GiteeOptions } from './types.js';
import { mtimePathFor, isMtimeSidecar, sidecarToDataPath, shaHash, apiPath } from './utils.js';

/**
 * Minimal snapshot entry type, compatible with zen-fs-sync's FileSnapshot.
 * Defined locally to avoid a dependency on zen-fs-sync.
 */
export interface SnapshotEntry {
	path: string;
	size: number;
	mtimeMs: number;
}

/**
 * Minimal sync filter type, compatible with zen-fs-sync's SyncFilter.
 */
export interface SnapshotFilter {
	includePrefixes?: string[];
	excludePrefixes?: string[];
	includeGlobs?: string[];
}

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
	/** Cached file mtime entries: path -> { sha, lastModified }. Populated lazily via Commits API. */
	readonly mtimeCache = new Map<string, { sha: string; lastModified: string }>();
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
			const isDir = item.type === 'tree';

			// Skip mtime sidecar files — they are internal metadata, not user files.
			// But cache their SHA so we can delete them atomically later.
			if (!isDir && isMtimeSidecar(item.path)) {
				this.shaCache.set(path, item.sha);
				continue;
			}

			const id = this.index._alloc();
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
		// Preload regular file contents from the index
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
		// Also preload mtime sidecar files (not in index but in shaCache)
		// so stat() can read mtime without triggering extra API calls
		for (const [path] of this.shaCache) {
			if (!isMtimeSidecar(path)) continue;
			if (this.contentCache.has(path)) continue;
			try {
				const data = new Uint8Array(await this.api.getRaw(path));
				this.contentCache.set(path, data);
			} catch {
				// Ignore preload errors for sidecar files
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
		const sidecarPath = mtimePathFor(path);
		const dataSha = this.shaCache.get(path);
		const sidecarSha = this.shaCache.get(sidecarPath);

		// If both data file and sidecar exist, delete them atomically in one commit
		if (dataSha && sidecarSha) {
			await this.api.deleteMulti(
				[{ path }, { path: sidecarPath }],
				`Delete ${path} + sidecar`
			);
			this.shaCache.delete(path);
			this.shaCache.delete(sidecarPath);
		} else if (dataSha) {
			// Only data file exists — use single-file delete
			await this.api.deleteFile(path, dataSha, `Delete ${path}`);
			this.shaCache.delete(path);
		} else if (sidecarSha) {
			// Only sidecar exists (orphaned) — delete it too
			await this.api.deleteFile(sidecarPath, sidecarSha, `Delete orphaned sidecar ${sidecarPath}`);
			this.shaCache.delete(sidecarPath);
		}

		this.contentCache.delete(path);
		this.contentCache.delete(sidecarPath);
		this.mtimeCache.delete(path);
	}

	removeSync(path: string): void {
		const sidecarPath = mtimePathFor(path);
		const dataSha = this.shaCache.get(path);
		const sidecarSha = this.shaCache.get(sidecarPath);

		if (dataSha && sidecarSha) {
			this._queue(
				this.api.deleteMulti(
					[{ path }, { path: sidecarPath }],
					`Delete ${path} + sidecar`
				).then(() => {
					this.shaCache.delete(path);
					this.shaCache.delete(sidecarPath);
				}).catch(() => {})
			);
		} else if (dataSha) {
			this._queue(
				this.api.deleteFile(path, dataSha, `Delete ${path}`)
					.then(() => { this.shaCache.delete(path); })
					.catch(() => {})
			);
		} else if (sidecarSha) {
			this._queue(
				this.api.deleteFile(sidecarPath, sidecarSha, `Delete orphaned sidecar ${sidecarPath}`)
					.then(() => { this.shaCache.delete(sidecarPath); })
					.catch(() => {})
			);
		}

		this.contentCache.delete(path);
		this.contentCache.delete(sidecarPath);
		this.mtimeCache.delete(path);
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

	// --- Stat (overridden to provide real mtime from sidecar or Commits API) ---

	/**
	 * Get the stat of a file. For regular files, this enriches the Inode's
	 * mtimeMs with the real modification time.
	 *
	 * Priority:
	 * 1. Cached mtime (mtimeCache) — if SHA hasn't changed, return cached value
	 * 2. mtime sidecar file (most precise — stores millisecond mtime)
	 * 3. Commits API (second-level precision, fallback for files without sidecar)
	 * 4. Inode's default mtimeMs (set during init or write)
	 *
	 * The sidecar is only checked when the blob SHA has changed (i.e., file
	 * content changed) or there is no cached mtime. This avoids repeated API
	 * calls for unchanged files.
	 */
	override async stat(path: string): Promise<Inode> {
		const inode = await super.stat(path);

		// Only enrich mtime for regular files
		if ((inode.mode & S_IFREG) !== S_IFREG) return inode;

		const currentSha = this.shaCache.get(path);
		const cached = this.mtimeCache.get(path);

		// 1. If cached SHA matches current SHA, use cached mtime (no API calls)
		if (cached && cached.sha === currentSha && cached.lastModified) {
			inode.update({ mtimeMs: new Date(cached.lastModified).getTime() });
			return inode;
		}

		// SHA changed or no cache — need to fetch mtime.
		// 2. Try reading mtime from sidecar file first (most precise)
		const sidecarPath = mtimePathFor(path);
		try {
			const sidecarData = this.contentCache.get(sidecarPath)
				|| (await this.api.getRaw(sidecarPath)) as ArrayBuffer;
			const sidecarBytes = sidecarData instanceof Uint8Array
				? sidecarData
				: new Uint8Array(sidecarData);
			const mtimeStr = new TextDecoder().decode(sidecarBytes).trim();
			const mtimeMs = Number(mtimeStr);
			if (!isNaN(mtimeMs) && mtimeMs > 0) {
				inode.update({ mtimeMs });
				this.contentCache.set(sidecarPath, sidecarBytes);
				// Cache in mtimeCache so subsequent calls don't re-read sidecar
				if (currentSha) {
					this.mtimeCache.set(path, { sha: currentSha, lastModified: new Date(mtimeMs).toISOString() });
				}
				return inode;
			}
		} catch {
			// No sidecar exists — fall through to Commits API
		}

		// 3. Fall back to Commits API for files without sidecar
		if (currentSha) {
			const commit = await this.api.getLastCommit(path);
			if (commit) {
				this.mtimeCache.set(path, { sha: currentSha, lastModified: commit.date });
				inode.update({ mtimeMs: new Date(commit.date).getTime() });
				return inode;
			}
		}

		return inode;
	}

	// -----------------------------------------------------------------------
	// writeFileWithMtime — write file + mtime sidecar atomically
	// -----------------------------------------------------------------------

	/**
	 * Write a file and preserve the specified mtime by writing a sidecar file
	 * (`.filename.mtime`) containing the mtimeMs as a string.
	 *
	 * Both the data file and its sidecar are committed in a single atomic Git
	 * commit using `createOrUpdateMulti`, so other clients never see a partial
	 * state (data without sidecar or vice versa).
	 *
	 * This is called by zen-fs-sync's `copyFile()` to preserve the source
	 * file's real mtime across sync, since Git commit time only has second-level
	 * precision and doesn't reflect the actual file modification time.
	 */
	async writeFileWithMtime(path: string, data: string | Uint8Array, mtimeMs: number): Promise<void> {
		// Normalize data to Uint8Array
		const content = typeof data === 'string'
			? new TextEncoder().encode(data)
			: data;

		// 1. Update content cache
		this.contentCache.set(path, content);

		// 2. Update inode with the specified mtime
		const inode = this.index.get(path);
		if (inode) {
			inode.update({ mtimeMs, size: content.length });
		}

		// 3. Build sidecar content (mtimeMs as string)
		const sidecarPath = mtimePathFor(path);
		const sidecarContent = new TextEncoder().encode(String(mtimeMs));

		// 4. Atomic commit: data file + sidecar in one commit
		const result = await this.api.createOrUpdateMulti(
			[
				{ path, content },
				{ path: sidecarPath, content: sidecarContent },
			],
			`Update ${path} (mtime=${mtimeMs})`,
		);

		// 5. Update SHA caches
		const dataSha = result.get(path);
		if (dataSha) this.shaCache.set(path, dataSha);
		const sidecarSha = result.get(sidecarPath);
		if (sidecarSha) this.shaCache.set(sidecarPath, sidecarSha);

		// 6. Cache sidecar content for future stat() reads
		this.contentCache.set(sidecarPath, sidecarContent);
	}

	// -----------------------------------------------------------------------
	// createSnapshot — efficient snapshot using Git tree API
	// -----------------------------------------------------------------------

	/**
	 * Build a file snapshot efficiently using the Git tree API.
	 *
	 * Instead of walking the filesystem and calling `stat()` for each file
	 * (which would trigger N API calls), this method fetches the entire tree
	 * in a single API request and builds the snapshot from tree items.
	 *
	 * Uses `shaHash(blobSha)` as a proxy for `mtimeMs` — different content
	 * produces a different SHA, which produces a different hash value, which
	 * the sync engine detects as a change. This is more reliable than commit
	 * timestamps (which have only second-level precision and may be identical
	 * for multiple files committed together).
	 *
	 * Sidecar files (`.filename.mtime`) are excluded from the snapshot so they
	 * don't appear as user-visible files.
	 *
	 * If the Gitee API is unreachable, returns `null` to signal that the
	 * snapshot could not be built.
	 */
	async createSnapshot(
		root: string,
		filter?: SnapshotFilter,
	): Promise<Map<string, SnapshotEntry> | null> {
		try {
			const tree = await this.api.getTree(true);
			const snapshot = new Map<string, SnapshotEntry>();

			for (const item of tree) {
				// Skip directories
				if (item.type === 'tree') continue;

				// Skip mtime sidecar files
				if (isMtimeSidecar(item.path)) continue;

				const fullPath = '/' + item.path;

				// Apply root filter: only include files under the specified root
				const normalizedRoot = root === '/' ? '' : root;
				if (normalizedRoot && !fullPath.startsWith(normalizedRoot + '/')) {
					continue;
				}

				// Compute relative path from root
				const relPath = normalizedRoot
					? fullPath.slice(normalizedRoot.length + 1)
					: fullPath.slice(1);

				// Apply include/exclude prefix filters
				if (filter) {
					if (filter.excludePrefixes?.some(p => relPath.startsWith(p))) continue;
					if (filter.includePrefixes && filter.includePrefixes.length > 0) {
						if (!filter.includePrefixes.some(p => relPath.startsWith(p))) continue;
					}
				}

				// Use shaHash as mtimeMs proxy: different content → different SHA → different hash
				const mtimeMsProxy = shaHash(item.sha);

				snapshot.set(relPath, {
					path: relPath,
					size: item.size || 0,
					mtimeMs: mtimeMsProxy,
				});
			}

			return snapshot;
		} catch (err) {
			console.warn(`[GiteeFS] createSnapshot failed:`, err);
			return null;
		}
	}

	/**
	 * Get the blob SHA for a file (from shaCache). Useful for external
	 * revision checking (e.g. zen-fs-cache getRevision).
	 */
	getFileSha(path: string): string | undefined {
		return this.shaCache.get(path);
	}
}
