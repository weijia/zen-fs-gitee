import { IndexFS, Inode } from '@zenfs/core';
import { GiteeAPI } from './gitee-api.js';
import type { GiteeOptions } from './types.js';
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
     * mtimeMs with the real last commit date from the Gitee Commits API.
     * The first call for a file triggers an API request; subsequent calls
     * use the cached value unless the blob SHA has changed.
     */
    stat(path: string): Promise<Inode>;
    /**
     * Get the blob SHA for a file (from shaCache). Useful for external
     * revision checking (e.g. zen-fs-cache getRevision).
     */
    getFileSha(path: string): string | undefined;
}
//# sourceMappingURL=gitee-fs.d.ts.map