import { IndexFS, Inode } from '@zenfs/core';
import { GiteeAPI } from './gitee-api.js';
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
    /** Maps file paths to their blob SHA (needed for updates/deletes). */
    readonly shaCache: Map<string, string>;
    /** In-memory content cache to support synchronous reads. */
    readonly contentCache: Map<string, Uint8Array<ArrayBufferLike>>;
    /** Cached file mtime entries: path -> { sha, lastModified }. Populated lazily via Commits API. */
    readonly mtimeCache: Map<string, {
        sha: string;
        lastModified: string;
    }>;
    /** Serializes async background operations. */
    private pending;
    private options;
    private initialized;
    constructor(options: GiteeOptions);
    /**
     * Queue an async operation to run after all previous ones finish.
     * Used by sync methods to trigger background writes/deletes.
     */
    private _queue;
    /**
     * Initialize the file system by loading the repository tree.
     * If the configured branch does not exist, it will be created from 'master'.
     */
    init(): Promise<void>;
    /**
     * Preload all file contents into memory cache.
     * This enables synchronous reads.
     */
    preloadContents(): Promise<void>;
    ready(): Promise<void>;
    readySync(): void;
    remove(path: string): Promise<void>;
    removeSync(path: string): void;
    read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void>;
    readSync(path: string, buffer: Uint8Array, start: number, end: number): void;
    write(path: string, data: Uint8Array, offset: number): Promise<void>;
    writeSync(path: string, data: Uint8Array, offset: number): void;
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
     * Both the data file and its sidecar are committed in a single atomic Git
     * commit using `createOrUpdateMulti`, so other clients never see a partial
     * state (data without sidecar or vice versa).
     *
     * This is called by zen-fs-sync's `copyFile()` to preserve the source
     * file's real mtime across sync, since Git commit time only has second-level
     * precision and doesn't reflect the actual file modification time.
     */
    writeFileWithMtime(path: string, data: string | Uint8Array, mtimeMs: number): Promise<void>;
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
    createSnapshot(root: string, filter?: SnapshotFilter): Promise<Map<string, SnapshotEntry> | null>;
    /**
     * Get the blob SHA for a file (from shaCache). Useful for external
     * revision checking (e.g. zen-fs-cache getRevision).
     */
    getFileSha(path: string): string | undefined;
}
//# sourceMappingURL=gitee-fs.d.ts.map