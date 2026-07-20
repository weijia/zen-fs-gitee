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
    getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]>;
    getRaw(path: string): Promise<ArrayBuffer>;
    createFile(path: string, content: Uint8Array, message: string): Promise<void>;
    updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<void>;
    deleteFile(path: string, sha: string, message: string): Promise<void>;
}
//# sourceMappingURL=gitee-api.d.ts.map