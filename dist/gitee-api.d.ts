import type { GiteeOptions } from './types.js';
export interface GiteeTreeItem {
    path: string;
    mode: string;
    type: 'blob' | 'tree';
    sha: string;
    size?: number;
    url: string;
}
export interface GiteeContentItem {
    type: 'file' | 'dir';
    name: string;
    path: string;
    sha: string;
    size: number;
    content?: string;
    encoding?: 'base64';
    download_url?: string;
}
/**
 * Gitee API v5 wrapper.
 *
 * Only the Contents API (POST/PUT/DELETE /repos/{owner}/{repo}/contents/{path})
 * is used for write operations, because Gitee does NOT support the Git Data API
 * write endpoints (POST /git/blobs, POST /git/trees, POST /git/commits,
 * PATCH /git/refs). Those endpoints return 404 on Gitee.
 *
 * Git Data API GET endpoints (getTree, getBranchSha) are supported and used
 * for read-only operations.
 */
export declare class GiteeAPI {
    private token;
    private owner;
    private repo;
    private branch;
    private baseUrl;
    constructor(options: GiteeOptions);
    request(path: string, init?: RequestInit): Promise<any>;
    getTree(recursive?: boolean): Promise<GiteeTreeItem[]>;
    /**
     * Get the latest commit SHA of a branch via the Git refs API (GET, supported).
     */
    getBranchSha(branch: string): Promise<string>;
    /**
     * Create a new branch from an existing branch.
     * Uses POST /repos/{owner}/{repo}/branches — the only branch-creation
     * endpoint supported by Gitee.
     */
    createBranch(newBranch: string, fromRef?: string): Promise<void>;
    getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]>;
    getRaw(path: string): Promise<ArrayBuffer>;
    /**
     * Create a new file via Contents API. Returns the new blob SHA.
     * Gitee rejects empty content with "content is empty", so empty files
     * are stored as a single newline `\n` (1 byte).
     * Callers should be aware that 0-byte files become 1-byte on Gitee.
     */
    createFile(path: string, content: Uint8Array, message: string): Promise<string>;
    /**
     * Update an existing file via Contents API. Returns the new blob SHA.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     * Gitee rejects empty content — empty files are stored as `\n`.
     */
    updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<string>;
    /**
     * Delete a file via Contents API.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     */
    deleteFile(path: string, sha: string, message: string): Promise<void>;
    /**
     * Get the current blob SHA of a file via the Contents API (GET).
     */
    getFileSha(path: string): Promise<string | null>;
    /**
     * Get the last commit for a specific file path.
     * Returns the committer date as an ISO string.
     */
    getLastCommit(path: string): Promise<{
        date: string;
        sha: string;
    } | null>;
    /**
     * Get the latest commit SHA of the configured branch.
     * Useful for snapshot comparison without walking the tree.
     */
    getLatestCommitSha(): Promise<string | null>;
}
//# sourceMappingURL=gitee-api.d.ts.map