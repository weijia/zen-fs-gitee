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
     * Get the latest commit SHA of a branch.
     */
    getBranchSha(branch: string): Promise<string>;
    /**
     * Create a new branch from an existing branch or commit SHA.
     */
    createBranch(newBranch: string, fromRef?: string): Promise<void>;
    getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]>;
    getRaw(path: string): Promise<ArrayBuffer>;
    /**
     * Create a new blob. Returns the blob SHA.
     */
    createBlob(content: Uint8Array): Promise<string>;
    /**
     * Create a new tree based on a base tree, adding or updating a single file entry.
     * Returns the new tree SHA.
     */
    createTree(baseTree: string, filePath: string, blobSha: string, isDirectory?: boolean): Promise<string>;
    /**
     * Create a new commit. Returns the commit SHA.
     */
    createCommit(tree: string, message: string, parents: string[]): Promise<string>;
    /**
     * Update a ref (branch) to point to a new commit.
     */
    updateRef(ref: string, commitSha: string, force?: boolean): Promise<void>;
    /**
     * Create or update a file using the low-level Git API.
     * This handles empty files which the Contents API rejects with "content is empty".
     * Returns the new blob SHA.
     */
    private createOrUpdateViaGitApi;
    /**
     * Create a new file. Returns the new blob SHA.
     * Uses Git API for empty files since Gitee Contents API rejects empty content.
     */
    createFile(path: string, content: Uint8Array, message: string): Promise<string>;
    /**
     * Update an existing file. Returns the new blob SHA.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     * Uses Git API for empty files since Gitee Contents API rejects empty content.
     */
    updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<string>;
    /**
     * Delete a file.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     */
    deleteFile(path: string, sha: string, message: string): Promise<void>;
    /**
     * Get the current blob SHA of a file via the Contents API.
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
}
//# sourceMappingURL=gitee-api.d.ts.map