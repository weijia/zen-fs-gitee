import { IndexFS, Inode } from '@zenfs/core';
import { GiteeAPI, type GiteeTreeItem } from './gitee-api.js';
import type { GiteeOptions } from './types.js';
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
export declare class GiteeFS extends IndexFS {
    readonly api: GiteeAPI;
    /**
     * Human-readable backend identifier used by zen-fs-sync diagnostics
     * (e.g. naming the backend that leaked a mtime sidecar in a warning).
     */
    readonly backendName: string;
    /** Maps file paths to their blob SHA (needed for updates/deletes). */
    readonly shaCache: Map<string, string>;
    /** In-memory content cache to support synchronous reads. */
    readonly contentCache: Map<string, Uint8Array<ArrayBufferLike>>;
    /** Cached file mtime entries: path -> { sha, lastModified, fromSidecar }. */
    readonly mtimeCache: Map<string, {
        sha: string;
        lastModified: string;
        fromSidecar: boolean;
    }>;
    /** Paths confirmed (via 404) to have NO .mtime sidecar; value = timestamp. Avoids repeated 404s. */
    private readonly noSidecarCache;
    /** Serializes async background operations. */
    private pending;
    private options;
    private initialized;
    /** Last known commit SHA of the configured branch (baseline for shouldSync). */
    private lastCommitSha;
    /** Persists shaCache (path → blob SHA) across page reloads. */
    private readonly shaStore;
    /** Persists contentCache (path → file content) across page reloads. */
    private readonly contentStore;
    /** Persists mtimeCache (path → { sha, lastModified }) across page reloads. */
    private readonly mtimeStore;
    /** Persists lastCommitSha across page reloads for shouldSync baseline. */
    private readonly commitShaStore;
    constructor(options: GiteeOptions);
    /**
     * Queue an async operation to run after all previous ones finish.
     * Used by sync methods to trigger background writes/deletes.
     */
    private _queue;
    /** Persist a single shaCache entry to IndexedDB (fire-and-forget). */
    private _persistSha;
    /** Persist a single contentCache entry to IndexedDB (fire-and-forget). */
    private _persistContent;
    /** Persist a single mtimeCache entry to IndexedDB (fire-and-forget). */
    private _persistMtime;
    /** Delete a shaCache entry from IndexedDB (fire-and-forget). */
    private _deleteSha;
    /** Delete a contentCache entry from IndexedDB (fire-and-forget). */
    private _deleteContent;
    /** Delete a mtimeCache entry from IndexedDB (fire-and-forget). */
    private _deleteMtime;
    /**
     * Load all persistent caches from IndexedDB into the in-memory Maps.
     * Called at the start of `init()` to enable a warm start — file contents
     * and SHAs from the previous session are immediately available for sync
     * reads, avoiding redundant API calls for unchanged files.
     */
    private loadFromIDB;
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
    init(): Promise<void>;
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
    preloadContents(): Promise<void>;
    ready(): Promise<void>;
    readySync(): void;
    remove(path: string): Promise<void>;
    removeSync(path: string): void;
    read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void>;
    readSync(path: string, buffer: Uint8Array, start: number, end: number): void;
    write(path: string, data: Uint8Array, offset: number, mtimeMs?: number): Promise<void>;
    writeSync(path: string, data: Uint8Array, offset: number, mtimeMs?: number): void;
    /** Write/update the `.mtime` sidecar for a file (async). */
    private writeMtimeSidecar;
    /** Write/update the `.mtime` sidecar for a file (sync, queued). */
    private writeMtimeSidecarSync;
    /**
     * Override base `writeFile` so an optional `{ mtime }` option is forwarded
     * to `write()` and persisted in the `.mtime` sidecar. This is what makes
     * cross-backend mtime preservation actually take effect when the sync
     * engine writes through `writeFile({ mtime })` (e.g. via CachedFileSystem
     * + adapter), not only through `writeFileWithMtime`.
     */
    writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void>;
    writeFileSync(path: string, data: string | Uint8Array, options?: any): void;
    sync(): Promise<void>;
    syncSync(): void;
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
    stat(path: string): Promise<Inode>;
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
    writeFileWithMtime(path: string, data: string | Uint8Array, mtimeMs: number): Promise<void>;
    /**
     * True when `content` is byte-identical to the file's currently cached remote
     * content.
     *
     * Used to skip re-writing the data file (and its commit) when only the mtime
     * changed — see {@link writeFileWithMtime} / {@link write}. This is a pure
     * in-memory check (zero network): in a normal sync the data content is
     * already cached by `preloadContents()` / `read()` before `writeFileWithMtime`
     * is called, so the comparison is reliable. On a cache miss we return `false`
     * (assume changed → write the data file) rather than fetching, which keeps
     * behaviour predictable and avoids an extra read on every write.
     */
    private isContentUnchanged;
    /**
     * Return a legitimate, cached mtime (ms) for a file without re-querying the
     * API, or `undefined` if one must be fetched. Mirrors `stat()`'s trust rules:
     * a sidecar-derived value (fromSidecar:true) is always trusted while the SHA
     * is unchanged; a commit-time value (fromSidecar:false) is trusted only
     * within the negative-sidecar window (we've confirmed no sidecar exists for
     * this path). Returns undefined otherwise so the caller re-fetches via the
     * Commits API (a sidecar written later would otherwise be missed).
     */
    private _cachedLegitMtime;
    /**
     * Build a file snapshot efficiently using the Git tree API.
     *
     * Instead of walking the filesystem and calling `stat()` for each file
     * (which would trigger N API calls), this method fetches the entire tree
     * in a single API request and builds the snapshot from tree items.
     *
     * mtimeMs is taken from the `.mtime` sidecar when available (the real
     * modification time preserved across sync — see DESIGN.md §4), so the
     * target-side mtime stays comparable with the source's real mtime. When a
     * file has no sidecar (legacy writes), it falls back to the file's last
     * commit time from the Commits API (`getLastCommit`) — a real timestamp,
     * cached in mtimeCache (fromSidecar:false) and amortized across cycles via
     * the noSidecarCache negative window. Commit time has only second-level
     * precision and is shared across files committed together, but it is a
     * legitimate mtime (unlike a content hash) and is superseded by the real
     * sidecar mtime once the file is re-written.
     *
     * Sidecar files (`.filename.mtime`) are excluded from the snapshot so they
     * don't appear as user-visible files.
     *
     * If the Gitee API is unreachable, returns `null` to signal that the
     * snapshot could not be built.
     */
    createSnapshot(root: string, filter?: SnapshotFilter): Promise<Map<string, SnapshotEntry> | null>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: any): Promise<any>;
    rmdir(path: string): Promise<void>;
    /**
    * Recursively delete `.mtime` sidecar files whose data file no longer
    * exists in the Gitee repo (orphaned sidecars). Returns the number of
    * sidecars removed. Safe to call at any time; each deletion is best-effort.
    *
    * NOTE: `createSnapshot()` already prunes orphans on the fly during normal
    * sync; this method forces an explicit, on-demand full cleanup.
    */
    pruneOrphanedMtimeSidecars(root?: string): Promise<number>;
    /**
    * Delete stale hidden metadata files in the Gitee repo, unconditionally:
    *  - single-dot `.version`/`.mtime` sidecars (`.name.mtime` / `.name.version`)
    *  - any `..`-prefixed file (`..name`, `..name.mtime`, ...)
    * Detection is OR, never AND (see {@link isMetadataSidecarToDelete}).
    * Returns the number of files removed. Safe to call at any time; each
    * deletion is best-effort.
    *
    * NOTE: `init()` and `createSnapshot()` already delete these sidecars on
    * the fly during normal operation; this method forces an explicit,
    * on-demand full cleanup (e.g. from a maintenance task).
    */
    deleteMetadataSidecars(root?: string, preloadedTree?: GiteeTreeItem[]): Promise<number>;
    /**
    * Get the blob SHA for a file (from shaCache). Useful for external
* revision checking (e.g. zen-fs-cache getRevision).
*/
    getFileSha(path: string): string | undefined;
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
    getRevision(path: string): Promise<string | number | undefined>;
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
    shouldSync(): Promise<boolean>;
}
//# sourceMappingURL=gitee-fs.d.ts.map