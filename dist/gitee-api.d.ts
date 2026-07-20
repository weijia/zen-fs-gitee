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
     *
     * Strategy:
     *  1. Try the dedicated POST /branches API (Gitee native).
     *  2. If the repo has NO branches at all (empty repo), the above
     *     will fail because there is no base ref. Fall back to creating
     *     an initial file via the Contents API, which implicitly creates
     *     the branch on the server side.
     */
    createBranch(newBranch: string, fromRef?: string): Promise<void>;
    getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]>;
    getRaw(path: string): Promise<ArrayBuffer>;
    createFile(path: string, content: Uint8Array, message: string): Promise<void>;
    updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<void>;
    deleteFile(path: string, sha: string, message: string): Promise<void>;
}
//# sourceMappingURL=gitee-api.d.ts.map