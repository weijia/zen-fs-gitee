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
     * Create a new file. Returns the new blob SHA.
     */
    createFile(path: string, content: Uint8Array, message: string): Promise<string>;
    /**
     * Update an existing file. Returns the new blob SHA.
     * On "SHA does not match" error, fetches the current SHA and retries once.
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