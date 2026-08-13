import { withErrno } from 'kerium';
import { IndexFS, Index, Inode } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/constants';
import type { CreationOptions, InodeLike } from '@zenfs/core';
import { IdbKVStore } from 'zen-fs-cache';
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

	/** Last known commit SHA of the configured branch (baseline for shouldSync). */
	private lastCommitSha: string | null = null;

	// --- IndexedDB persistence for internal caches ---
	/** Persists shaCache (path → blob SHA) across page reloads. */
	private readonly shaStore: IdbKVStore;
	/** Persists contentCache (path → file content) across page reloads. */
	private readonly contentStore: IdbKVStore;
	/** Persists mtimeCache (path → { sha, lastModified }) across page reloads. */
	private readonly mtimeStore: IdbKVStore;
	/** Persists lastCommitSha across page reloads for shouldSync baseline. */
	private readonly commitShaStore: IdbKVStore;

	constructor(options: GiteeOptions) {
		super(0x6769746565, 'gitee', new Index());
		this.options = options;
		this.api = new GiteeAPI(options);
		// Each repo gets its own set of IndexedDB databases, namespaced by owner/repo.
		const dbBase = `zen-fs-gitee:${options.owner}/${options.repo}`;
		this.shaStore = new IdbKVStore(`${dbBase}:sha`, 'cache');
		this.contentStore = new IdbKVStore(`${dbBase}:content`, 'cache');
		this.mtimeStore = new IdbKVStore(`${dbBase}:mtime`, 'cache');
		this.commitShaStore = new IdbKVStore(`${dbBase}:commit-sha`, 'cache');
	}

	/**
	 * Queue an async operation to run after all previous ones finish.
	 * Used by sync methods to trigger background writes/deletes.
	 */
	private _queue(p: Promise<void>): void {
		this.pending = this.pending.then(() => p).catch(() => {});
	}

	// --- IndexedDB persistence helpers ---

	/** Persist a single shaCache entry to IndexedDB (fire-and-forget). */
	private _persistSha(path: string, sha: string): void {
		this.shaStore.set(path, sha).catch(() => {});
	}

	/** Persist a single contentCache entry to IndexedDB (fire-and-forget). */
	private _persistContent(path: string, data: Uint8Array): void {
		this.contentStore.set(path, data).catch(() => {});
	}

	/** Persist a single mtimeCache entry to IndexedDB (fire-and-forget). */
	private _persistMtime(path: string, entry: { sha: string; lastModified: string }): void {
		this.mtimeStore.set(path, entry).catch(() => {});
	}

	/** Delete a shaCache entry from IndexedDB (fire-and-forget). */
	private _deleteSha(path: string): void {
		this.shaStore.delete(path).catch(() => {});
	}

	/** Delete a contentCache entry from IndexedDB (fire-and-forget). */
	private _deleteContent(path: string): void {
		this.contentStore.delete(path).catch(() => {});
	}

	/** Delete a mtimeCache entry from IndexedDB (fire-and-forget). */
	private _deleteMtime(path: string): void {
		this.mtimeStore.delete(path).catch(() => {});
	}

	/**
	 * Load all persistent caches from IndexedDB into the in-memory Maps.
	 * Called at the start of `init()` to enable a warm start — file contents
	 * and SHAs from the previous session are immediately available for sync
	 * reads, avoiding redundant API calls for unchanged files.
	 */
	private async loadFromIDB(): Promise<void> {
		const [shaEntries, contentEntries, mtimeEntries, savedCommitSha] = await Promise.all([
			this.shaStore.entries<string>(),
			this.contentStore.entries<Uint8Array>(),
			this.mtimeStore.entries<{ sha: string; lastModified: string }>(),
			this.commitShaStore.get<string>('lastCommitSha'),
		]);
		for (const [path, sha] of shaEntries) {
			this.shaCache.set(path, sha);
		}
		for (const [path, data] of contentEntries) {
			this.contentCache.set(path, data);
		}
		for (const [path, entry] of mtimeEntries) {
			this.mtimeCache.set(path, entry);
		}
		this.lastCommitSha = savedCommitSha ?? null;
		console.log(`[GiteeFS] IDB restore: ${shaEntries.length} SHAs, ${contentEntries.length} contents, ${mtimeEntries.length} mtime entries, commitSha=${this.lastCommitSha?.slice(0, 7) ?? 'none'}`);
	}

	/**
	 * Initialize the file system by loading the repository tree.
	 * If the configured branch does not exist, it will be created from 'master'.
	 *
	 * Warm start: persistent caches (shaCache, contentCache, mtimeCache) are
	 * loaded from IndexedDB first, so file contents from the previous session
	 * are immediately available. The tree API then provides fresh SHAs —
	 * files whose SHA hasn't changed keep their cached content (zero
	 * re-fetching), while changed files are invalidated for on-demand re-read.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		// 1. Warm start: load persistent caches from IndexedDB
		await this.loadFromIDB();

		// 2. Fetch fresh tree from API
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

		// 3. Build index from fresh tree, reusing cached content where SHA is unchanged
		const freshPaths = new Set<string>();
		const shaUpdates: [string, string][] = [];

		for (const item of tree) {
			const path = '/' + item.path;
			const isDir = item.type === 'tree';
			freshPaths.add(path);

			// Skip mtime sidecar files — they are internal metadata, not user files.
			// But cache their SHA so we can delete them atomically later.
			if (!isDir && isMtimeSidecar(item.path)) {
				const oldSha = this.shaCache.get(path);
				this.shaCache.set(path, item.sha);
				if (oldSha !== item.sha) shaUpdates.push([path, item.sha]);
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
				const oldSha = this.shaCache.get(path);
				this.shaCache.set(path, item.sha);
				shaUpdates.push([path, item.sha]);
				// If SHA changed, invalidate cached content (will be re-fetched on demand)
				if (oldSha && oldSha !== item.sha) {
					this.contentCache.delete(path);
					this._deleteContent(path);
					// mtimeCache is also invalid — SHA changed
					this.mtimeCache.delete(path);
					this._deleteMtime(path);
				}
			}
		}

		// 4. Remove stale entries (files deleted from remote since last session)
		const stalePaths: string[] = [];
		for (const [path] of this.shaCache) {
			if (!freshPaths.has(path)) {
				stalePaths.push(path);
			}
		}
		for (const path of stalePaths) {
			this.shaCache.delete(path);
			this.contentCache.delete(path);
			this.mtimeCache.delete(path);
			this._deleteSha(path);
			this._deleteContent(path);
			this._deleteMtime(path);
		}

		// 5. Bulk-persist updated SHAs to IndexedDB
		if (shaUpdates.length > 0) {
			this.shaStore.setMany(shaUpdates).catch(() => {});
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

		// 6. Record current commit SHA as shouldSync baseline
		//    On first init (no prior baseline), set it so shouldSync doesn't
		//    force an unnecessary full sync on the very first poll.
		if (!this.lastCommitSha) {
			try {
				this.lastCommitSha = await this.api.getLatestCommitSha();
				if (this.lastCommitSha) {
					this.commitShaStore.set('lastCommitSha', this.lastCommitSha).catch(() => {});
				}
			} catch { /* non-fatal — shouldSync will return true */ }
		}

		this.initialized = true;
	}

	/**
	 * Preload all file contents into memory cache.
	 * This enables synchronous reads.
	 *
	 * Uses bounded concurrency (default 8) to parallelize API calls.
	 * Skips tombstone files (.meta/.deleted/) and version sidecar files
	 * (.version) since they are metadata, not user content.
	 *
	 * Files already in contentCache (restored from IndexedDB during init)
	 * are skipped — they don't need re-fetching from the API.
	 */
	async preloadContents(): Promise<void> {
		const CONCURRENCY = 8;

		// Collect all paths that need preloading
		const pathsToPreload: string[] = [];

		// Regular files from the index
		for (const [path, node] of this.index) {
			if ((node.mode & S_IFREG) !== S_IFREG) continue;
			if (this.contentCache.has(path)) continue; // already cached (from IDB or previous read)
			// Skip tombstone files and version sidecars — they are metadata,
			// not user content, and are read on demand by the sync engine.
			if (path.includes('/.meta/.deleted/')) continue;
			if (path.endsWith('.version')) continue;
			pathsToPreload.push(path);
		}

		// Mtime sidecar files (not in index but in shaCache)
		for (const [path] of this.shaCache) {
			if (!isMtimeSidecar(path)) continue;
			if (this.contentCache.has(path)) continue;
			if (path.includes('/.meta/.deleted/')) continue;
			pathsToPreload.push(path);
		}

		// Fetch in parallel with bounded concurrency
		let index = 0;
		const fetchOne = async (): Promise<void> => {
			while (index < pathsToPreload.length) {
				const path = pathsToPreload[index++];
				try {
					const data = new Uint8Array(await this.api.getRaw(path));
					this.contentCache.set(path, data);
					// Persist newly fetched content to IndexedDB
					this._persistContent(path, data);
				} catch {
					// Ignore preload errors for individual files
				}
			}
		};

		const workers = Array.from({ length: Math.min(CONCURRENCY, pathsToPreload.length) }, () => fetchOne());
		await Promise.all(workers);
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

		// Delete data file and sidecar separately via Contents API.
		// Gitee only supports the Contents API for file deletion
		// (DELETE /repos/{owner}/{repo}/contents/{path}).
		if (dataSha) {
			await this.api.deleteFile(path, dataSha, `Delete ${path}`);
			this.shaCache.delete(path);
			this._deleteSha(path);
		}
		if (sidecarSha) {
			await this.api.deleteFile(sidecarPath, sidecarSha, `Delete sidecar ${sidecarPath}`);
			this.shaCache.delete(sidecarPath);
			this._deleteSha(sidecarPath);
		}

		this.contentCache.delete(path);
		this.contentCache.delete(sidecarPath);
		this._deleteContent(path);
		this._deleteContent(sidecarPath);
		this.mtimeCache.delete(path);
		this._deleteMtime(path);
		// Remove from the in-memory Index so stat()/exists() correctly
		// report the file as deleted. Without this, the Index retains a
		// stale entry and stat() keeps returning the old inode, causing
		// tombstone processors and sync engines to think the file still
		// exists and repeatedly attempt deletion.
		this.index.delete(path);
	}

	removeSync(path: string): void {
		const sidecarPath = mtimePathFor(path);
		const dataSha = this.shaCache.get(path);
		const sidecarSha = this.shaCache.get(sidecarPath);

		// Delete data file and sidecar separately via Contents API.
		// See remove() for explanation.
		if (dataSha) {
			this._queue(
				this.api.deleteFile(path, dataSha, `Delete ${path}`)
					.then(() => { this.shaCache.delete(path); this._deleteSha(path); })
					.catch(() => {})
			);
		}
		if (sidecarSha) {
			this._queue(
				this.api.deleteFile(sidecarPath, sidecarSha, `Delete sidecar ${sidecarPath}`)
					.then(() => { this.shaCache.delete(sidecarPath); this._deleteSha(sidecarPath); })
					.catch(() => {})
			);
		}

		this.contentCache.delete(path);
		this.contentCache.delete(sidecarPath);
		this._deleteContent(path);
		this._deleteContent(sidecarPath);
		this.mtimeCache.delete(path);
		this._deleteMtime(path);
		// Remove from the in-memory Index — see remove() for explanation.
		this.index.delete(path);
	}

	// --- Read ---

	async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
		if (end - start <= 0) return;
		let data = this.contentCache.get(path);
		if (!data) {
			data = new Uint8Array(await this.api.getRaw(path));
			this.contentCache.set(path, data);
			// Persist newly fetched content to IndexedDB
			this._persistContent(path, data);
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

		// Gitee can't store 0-byte files — use \n as placeholder
		const writeContent = merged.length === 0
			? new TextEncoder().encode('\n')
			: merged;
		this.contentCache.set(path, writeContent);
		this._persistContent(path, writeContent);

		const inode = this.index.get(path);
		if (inode) {
			inode.update({ mtimeMs: Date.now(), size: writeContent.length });
		}

		const sha = this.shaCache.get(path);
		if (sha) {
			const newSha = await this.api.updateFile(path, writeContent, sha, `Update ${path}`);
			this.shaCache.set(path, newSha);
			this._persistSha(path, newSha);
		} else {
			const newSha = await this.api.createFile(path, writeContent, `Create ${path}`);
			this.shaCache.set(path, newSha);
			this._persistSha(path, newSha);
		}
	}

	writeSync(path: string, data: Uint8Array, offset: number): void {
		let existing = this.contentCache.get(path) || new Uint8Array(0);
		const newSize = Math.max(existing.length, offset + data.length);
		const merged = new Uint8Array(newSize);
		merged.set(existing);
		merged.set(data, offset);

		// Gitee can't store 0-byte files — use \n as placeholder
		const writeContent = merged.length === 0
			? new TextEncoder().encode('\n')
			: merged;
		this.contentCache.set(path, writeContent);
		this._persistContent(path, writeContent);

		const inode = this.index.get(path);
		if (inode) {
			inode.update({ mtimeMs: Date.now(), size: writeContent.length });
		}

		const sha = this.shaCache.get(path);
		this._queue(
			(sha
				? this.api.updateFile(path, writeContent, sha, `Update ${path}`)
				: this.api.createFile(path, writeContent, `Create ${path}`)
			)
				.then((newSha) => {
					this.shaCache.set(path, newSha);
					this._persistSha(path, newSha);
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
		// Only attempt to read the sidecar if it exists in shaCache (i.e.,
		// it was present in the Git tree). This avoids unnecessary 404 API
		// calls for files that have never been written with writeFileWithMtime.
		if (this.shaCache.has(sidecarPath) || this.contentCache.has(sidecarPath)) {
			try {
				const sidecarData = this.contentCache.get(sidecarPath)
					|| (await this.api.getRaw(sidecarPath)) as ArrayBuffer;
				const sidecarBytes = sidecarData instanceof Uint8Array
					? sidecarData
					: new Uint8Array(sidecarData);
				// Persist sidecar content if it was fetched from API
				if (!this.contentCache.has(sidecarPath)) {
					this.contentCache.set(sidecarPath, sidecarBytes);
					this._persistContent(sidecarPath, sidecarBytes);
				}
				const mtimeStr = new TextDecoder().decode(sidecarBytes).trim();
				const mtimeMs = Number(mtimeStr);
				if (!isNaN(mtimeMs) && mtimeMs > 0) {
					inode.update({ mtimeMs });
					// Cache in mtimeCache so subsequent calls don't re-read sidecar
					if (currentSha) {
						const mtimeEntry = { sha: currentSha, lastModified: new Date(mtimeMs).toISOString() };
						this.mtimeCache.set(path, mtimeEntry);
						this._persistMtime(path, mtimeEntry);
					}
					return inode;
				}
			} catch {
				// Sidecar exists in cache but raw fetch failed — fall through to Commits API
			}
		}

		// 3. Fall back to Commits API for files without sidecar
		if (currentSha) {
			const commit = await this.api.getLastCommit(path);
			if (commit) {
				const mtimeEntry = { sha: currentSha, lastModified: commit.date };
				this.mtimeCache.set(path, mtimeEntry);
				this._persistMtime(path, mtimeEntry);
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
	 * Uses the Contents API (createFile/updateFile) for both the data file and
	 * the sidecar, because Gitee only supports the Contents API for file writes.
	 * The Git Data API write endpoints return 404 on Gitee.
	 *
	 * The API calls are made FIRST, and only after both succeed are the local
	 * caches (contentCache, shaCache, inode) updated. This prevents a situation
	 * where the cache says the file exists but the remote was never actually
	 * written — which would cause the sync engine to make incorrect decisions
	 * on the next cycle (e.g., treating a file as "deleted from source" when
	 * it was never successfully written).
	 *
	 * This is called by zen-fs-sync's `copyFile()` to preserve the source
	 * file's real mtime across sync, since Git commit time only has second-level
	 * precision and doesn't reflect the actual file modification time.
	 */
	async writeFileWithMtime(path: string, data: string | Uint8Array, mtimeMs: number): Promise<void> {
		// Normalize data to Uint8Array
		let content = typeof data === 'string'
			? new TextEncoder().encode(data)
			: data;

		// Gitee can't store 0-byte files — substitute a single `\n`.
		// The contentCache and inode must reflect what's actually on Gitee
		// (1 byte), otherwise snapshot comparisons will always detect a
		// mismatch and trigger endless re-syncs.
		if (content.length === 0) {
			content = new TextEncoder().encode('\n');
		}

		// Build sidecar content (mtimeMs as string)
		const sidecarPath = mtimePathFor(path);
		const sidecarContent = new TextEncoder().encode(String(mtimeMs));

		// 1. Write data file via Contents API
		const existingDataSha = this.shaCache.get(path);
		let newDataSha: string;
		if (existingDataSha) {
			newDataSha = await this.api.updateFile(path, content, existingDataSha, `Update ${path} (mtime=${mtimeMs})`);
		} else {
			newDataSha = await this.api.createFile(path, content, `Create ${path} (mtime=${mtimeMs})`);
		}

		// 2. Write sidecar file via Contents API
		const existingSidecarSha = this.shaCache.get(sidecarPath);
		let newSidecarSha: string;
		if (existingSidecarSha) {
			newSidecarSha = await this.api.updateFile(sidecarPath, sidecarContent, existingSidecarSha, `Update sidecar for ${path}`);
		} else {
			newSidecarSha = await this.api.createFile(sidecarPath, sidecarContent, `Create sidecar for ${path}`);
		}

		// 3. Only after both API calls succeed, update local caches
		this.contentCache.set(path, content);
		this.contentCache.set(sidecarPath, sidecarContent);
		this._persistContent(path, content);
		this._persistContent(sidecarPath, sidecarContent);
		this.shaCache.set(path, newDataSha);
		this.shaCache.set(sidecarPath, newSidecarSha);
		this._persistSha(path, newDataSha);
		this._persistSha(sidecarPath, newSidecarSha);

		// 4. Update inode with the specified mtime
		const inode = this.index.get(path);
		if (inode) {
			inode.update({ mtimeMs, size: content.length });
		}
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

	/**
	 * Return a revision token for `path`, implementing the
	 * {@link CacheableFileSystem.getRevision} hook for zen-fs-cache.
	 *
	 * Returns the Git blob SHA from the in-memory `shaCache` — **zero network
	 * round-trips**. The SHA is populated during `init()` from a single
	 * `getTree` API call and updated on every `write` / `unlink` from the
	 * API response.
	 *
	 * - For **files**: returns the 40-char blob SHA (e.g. `"a1b2c3..."`).
	 *   The SHA changes whenever the file content changes, and remains stable
	 *   when it doesn't — exactly what the cache needs.
	 * - For **directories**: returns `undefined` (Git has no directory-level
	 *   blob SHA; tree SHAs are not cached). This causes the cache to re-read
	 *   the directory listing.
	 * - For **non-existent paths**: returns `undefined` (path is not in
	 *   `shaCache`), causing the cache to fall through to a full read which
	 *   will produce a 404/ENOENT.
	 */
	async getRevision(path: string): Promise<string | number | undefined> {
		return this.shaCache.get(path);
	}

	/**
	 * Check whether the remote branch has new commits since the last baseline.
	 *
	 * Implements the `SyncableFS.shouldSync()` hook for zen-fs-sync. Compares
	 * the latest commit SHA of the configured branch against the cached
	 * baseline (`lastCommitSha`). A single API call (`getBranchSha`) is all
	 * that's needed — no tree walk.
	 *
	 * - **SHA unchanged** → `false` (no remote change, skip sync)
	 * - **SHA changed** → `true`, and the baseline is updated so subsequent
	 *   polls return `false` until the next external commit
	 * - **First call (no baseline)** → `true` (triggers initial full sync),
	 *   then baseline is set
	 * - **API error** → `true` (fail-safe: trigger sync rather than miss updates)
	 */
	async shouldSync(): Promise<boolean> {
		try {
			const remoteSha = await this.api.getLatestCommitSha();
			if (!remoteSha) return true;
			if (remoteSha === this.lastCommitSha) return false;
			this.lastCommitSha = remoteSha;
			this.commitShaStore.set('lastCommitSha', remoteSha).catch(() => {});
			return true;
		} catch {
			return true;
		}
	}
}
