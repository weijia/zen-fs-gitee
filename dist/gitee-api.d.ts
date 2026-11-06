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
    /** User-configured branch. Never rewritten — fallbacks are runtime-only. */
    private branch;
    private baseUrl;
    /**
     * Branch actually used for API calls after a runtime fallback. `null` means
     * the configured branch. Kept separate from `branch` so the user's config
     * (and the UI) still shows what they typed.
     */
    private resolvedBranch;
    /** Raw user-configured branch (may be undefined). Used when bootstrapping an empty repo. */
    private configuredBranch?;
    /** Set once auto-initialization succeeded, so it never runs twice on one instance. */
    private autoInitialized;
    /** First auto-initialization error; repeated sync rounds rethrow it instead of writing again. */
    private autoInitError;
    constructor(options: GiteeOptions);
    /** Branch used by every API call (configured, or the resolved default after a fallback). */
    get currentBranch(): string;
    /** True when the configured branch was missing and a default branch was used instead. */
    get fellBackToDefaultBranch(): boolean;
    /** True when an empty repository was bootstrapped with an initial commit. */
    get autoInitializedEmptyRepo(): boolean;
    private static httpStatus;
    /**
     * The tree endpoint returns 404 both for "repo missing/no permission" and
     * "branch missing", so on a 404 ask the repository metadata and branch list
     * which case we are in.
     */
    private readRepoState;
    /**
     * Bootstrap an empty repository through the Contents API: creating
     * `.keep` produces the first commit. `POST /branches` is unusable here
     * because it requires an existing `refs` start point.
     *
     * `.keep` is the sync layer's hidden placeholder, so an initialized
     * repository still looks empty to readers while the branch/tree exist.
     *
     * Runs at most once per instance. On failure the error is cached so later
     * sync rounds never write again.
     */
    private initializeEmptyRepository;
    request(path: string, init?: RequestInit, opts?: {
        quiet404?: boolean;
    }): Promise<any>;
    getTree(recursive?: boolean): Promise<GiteeTreeItem[]>;
    /**
     * Get the latest commit SHA of a branch.
     *
     * NOTE: Gitee's Git Data API `GET /git/refs/heads/{branch}` is NOT reliably
     * supported — it returns 404 even for branches that clearly exist (e.g.
     * `git/trees/{branch}` resolves fine with HTTP 200). We therefore use the
     * Branches API `GET /repos/{owner}/{repo}/branches/{branch}`, which is fully
     * supported by Gitee and returns the branch's head commit SHA under
     * `commit.sha`.
     */
    getBranchSha(branch?: string): Promise<string | null>;
    /**
     * Create a new branch from an existing branch.
     * Uses POST /repos/{owner}/{repo}/branches — the only branch-creation
     * endpoint supported by Gitee.
     */
    createBranch(newBranch: string, fromRef?: string): Promise<void>;
    getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]>;
    /**
     * Read a raw file. `quiet404` marks an existence probe (e.g. an `.mtime`
     * sidecar check) where a 404 is an expected answer, not an error to log.
     */
    getRaw(path: string, opts?: {
        quiet404?: boolean;
    }): Promise<ArrayBuffer>;
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