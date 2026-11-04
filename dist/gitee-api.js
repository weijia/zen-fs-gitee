import { apiPath, encodeBase64 } from './utils.js';
import { createLogger } from '@richard432/localstorage-logger';
const log = createLogger('GiteeAPI');
/**
 * Verbose (request/response) API tracing. Hidden by default to avoid console
 * spam — enable with: localStorage.setItem('debug:verbose:GiteeAPI', '1')
 */
const VERBOSE_KEY = 'debug:verbose:GiteeAPI';
try {
    if (localStorage.getItem(VERBOSE_KEY) === null)
        localStorage.setItem(VERBOSE_KEY, '0');
}
catch {
    /* localStorage unavailable (Node.js) — stays hidden */
}
function verboseLog(...args) {
    try {
        if (localStorage.getItem(VERBOSE_KEY) === '1')
            console.log('[GiteeAPI]', ...args);
    }
    catch {
        /* ignore */
    }
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
export class GiteeAPI {
    token;
    owner;
    repo;
    /** User-configured branch. Never rewritten — fallbacks are runtime-only. */
    branch;
    baseUrl;
    /**
     * Branch actually used for API calls after a runtime fallback. `null` means
     * the configured branch. Kept separate from `branch` so the user's config
     * (and the UI) still shows what they typed.
     */
    resolvedBranch = null;
    constructor(options) {
        this.token = options.token;
        this.owner = options.owner;
        this.repo = options.repo;
        this.branch = options.branch || 'master';
        this.baseUrl = options.baseUrl || 'https://gitee.com/api/v5';
    }
    /** Branch used by every API call (configured, or the resolved default after a fallback). */
    get currentBranch() {
        return this.resolvedBranch ?? this.branch;
    }
    /** True when the configured branch was missing and a default branch was used instead. */
    get fellBackToDefaultBranch() {
        return this.resolvedBranch !== null && this.resolvedBranch !== this.branch;
    }
    static httpStatus(err) {
        const msg = err instanceof Error ? err.message : String(err);
        const match = /Gitee API (\d+)/.exec(msg);
        return match ? Number(match[1]) : null;
    }
    /**
     * The tree endpoint returns 404 both for "repo missing/no permission" and
     * "branch missing", so on a 404 ask the repository metadata (and, for empty
     * repos, the branch list) which case we are in.
     *
     * @returns The default branch to retry with, or `null` when the caller
     *          should surface the original 404.
     */
    async resolveBranchFallback() {
        let meta;
        try {
            meta = await this.request(`/repos/${this.owner}/${this.repo}`);
        }
        catch (err) {
            if (GiteeAPI.httpStatus(err) === 404) {
                throw new Error(`Gitee 仓库 ${this.owner}/${this.repo} 不存在或无权访问（请检查 owner/repo 和 token 权限）`);
            }
            log.log(`读取仓库信息失败（${err instanceof Error ? err.message : String(err)}），保留原始分支错误`);
            return null;
        }
        // Empty repository: no branch can be read or written until the web UI
        // creates the first commit.
        let branchCount = null;
        try {
            const list = await this.request(`/repos/${this.owner}/${this.repo}/branches`);
            branchCount = Array.isArray(list) ? list.length : null;
        }
        catch {
            /* fall back to default_branch below */
        }
        if (branchCount === 0) {
            throw new Error(`Gitee 仓库 ${this.owner}/${this.repo} 为空（无任何分支/提交），无法读取文件树：`
                + '请先在 Gitee 网页上完成一次初始化提交（例如创建 README）后再重试');
        }
        const defaultBranch = meta?.default_branch || undefined;
        if (!defaultBranch || defaultBranch === this.branch) {
            log.log(`指定分支 '${this.branch}' 不存在，且没有可用的默认分支（仓库未返回 default_branch），保留原始错误`);
            return null;
        }
        log.log(`指定分支 '${this.branch}' 不存在，已回落到默认分支 '${defaultBranch}'`);
        return defaultBranch;
    }
    async request(path, init) {
        const separator = path.includes('?') ? '&' : '?';
        const url = `${this.baseUrl}${path}${separator}access_token=${this.token}`;
        verboseLog(`request: ${init?.method || 'GET'} ${url}`);
        const response = await fetch(url, init);
        verboseLog(`response: status=${response.status} url=${response.url} type=${response.headers.get('content-type')}`);
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            log.log(`ERROR body: ${text.substring(0, 500)}`);
            throw new Error(`Gitee API ${response.status}: ${text}`);
        }
        if (response.status === 204)
            return undefined;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return response.json();
        }
        return response.arrayBuffer();
    }
    // -----------------------------------------------------------------------
    // Read-only Git Data API (supported by Gitee)
    // -----------------------------------------------------------------------
    async getTree(recursive = true) {
        const treePath = (branch) => `/repos/${this.owner}/${this.repo}/git/trees/${branch}?recursive=${recursive ? 1 : 0}`;
        try {
            const data = await this.request(treePath(this.currentBranch));
            return data.tree || [];
        }
        catch (err) {
            if (GiteeAPI.httpStatus(err) !== 404)
                throw err;
            const fallback = await this.resolveBranchFallback();
            if (!fallback)
                throw err;
            const data = await this.request(treePath(fallback));
            this.resolvedBranch = fallback;
            return data.tree || [];
        }
    }
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
    async getBranchSha(branch = this.currentBranch) {
        const data = await this.request(`/repos/${this.owner}/${this.repo}/branches/${branch}`);
        return data?.commit?.sha ?? null;
    }
    // -----------------------------------------------------------------------
    // Branch creation (POST /branches, supported by Gitee)
    // -----------------------------------------------------------------------
    /**
     * Create a new branch from an existing branch.
     * Uses POST /repos/{owner}/{repo}/branches — the only branch-creation
     * endpoint supported by Gitee.
     */
    async createBranch(newBranch, fromRef = 'master') {
        log.log(`creating branch '${newBranch}' from '${fromRef}'`);
        await this.request(`/repos/${this.owner}/${this.repo}/branches`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                branch_name: newBranch,
                refs: fromRef,
            }),
        });
        log.log(`branch '${newBranch}' created`);
    }
    // -----------------------------------------------------------------------
    // Contents API (GET / POST / PUT / DELETE — all supported by Gitee)
    // -----------------------------------------------------------------------
    async getContents(path) {
        return this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${this.currentBranch}`);
    }
    async getRaw(path) {
        return this.request(`/repos/${this.owner}/${this.repo}/raw/${apiPath(path)}?ref=${this.currentBranch}`);
    }
    /**
     * Create a new file via Contents API. Returns the new blob SHA.
     * Gitee rejects empty content with "content is empty", so empty files
     * are stored as a single newline `\n` (1 byte).
     * Callers should be aware that 0-byte files become 1-byte on Gitee.
     */
    async createFile(path, content, message) {
        if (content.length === 0) {
            content = new TextEncoder().encode('\n');
        }
        try {
            const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.currentBranch}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: encodeBase64(content),
                    message,
                }),
            });
            return data?.content?.sha || '';
        }
        catch (err) {
            if (GiteeAPI.httpStatus(err) === 404) {
                throw new Error(`Gitee 仓库 ${this.owner}/${this.repo} 无法写入：分支 '${this.currentBranch}' 不存在或仓库为空。`
                    + '若仓库为空，请先在 Gitee 网页上完成一次初始化提交（例如创建 README）后再写入');
            }
            throw err;
        }
    }
    /**
     * Update an existing file via Contents API. Returns the new blob SHA.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     * Gitee rejects empty content — empty files are stored as `\n`.
     */
    async updateFile(path, content, sha, message) {
        if (content.length === 0) {
            content = new TextEncoder().encode('\n');
        }
        try {
            const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.currentBranch}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: encodeBase64(content),
                    message,
                    sha,
                }),
            });
            return data?.content?.sha || '';
        }
        catch (err) {
            const msg = err.message || '';
            if (msg.includes('SHA does not match') || msg.includes('sha does not match') || msg.includes('Blob')) {
                log.warn(`SHA mismatch for ${path}, refreshing SHA and retrying...`);
                const freshSha = await this.getFileSha(path);
                if (freshSha) {
                    const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.currentBranch}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            content: encodeBase64(content),
                            message,
                            sha: freshSha,
                        }),
                    });
                    return data?.content?.sha || freshSha;
                }
            }
            throw err;
        }
    }
    /**
     * Delete a file via Contents API.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     */
    async deleteFile(path, sha, message) {
        try {
            await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.branch}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    sha,
                }),
            });
        }
        catch (err) {
            const msg = err.message || '';
            if (msg.includes('SHA does not match') || msg.includes('sha does not match') || msg.includes('Blob')) {
                log.warn(`SHA mismatch for delete ${path}, refreshing SHA and retrying...`);
                const freshSha = await this.getFileSha(path);
                if (freshSha) {
                    await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.currentBranch}`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            message,
                            sha: freshSha,
                        }),
                    });
                    return;
                }
            }
            // Gitee 对删除“已不存在的文件”返回 400（中文措辞“文件新建失败”）。
            // 目标文件既然已不在远端，删除即达成目的——视为成功，避免
            // createSnapshot 清理孤儿 sidecar / 处理 tombstone 时每次都被误报为失败。
            const stillExists = await this.getContents(path).then(() => true).catch(() => false);
            if (!stillExists)
                return;
            throw err;
        }
    }
    /**
     * Get the current blob SHA of a file via the Contents API (GET).
     */
    async getFileSha(path) {
        try {
            const data = await this.getContents(path);
            return data?.sha || null;
        }
        catch {
            return null;
        }
    }
    // -----------------------------------------------------------------------
    // Commits API (GET only — supported by Gitee)
    // -----------------------------------------------------------------------
    /**
     * Get the last commit for a specific file path.
     * Returns the committer date as an ISO string.
     */
    async getLastCommit(path) {
        try {
            const commits = await this.request(`/repos/${this.owner}/${this.repo}/commits?path=${apiPath(path)}&ref=${this.currentBranch}&per_page=1`);
            if (Array.isArray(commits) && commits.length > 0) {
                const commit = commits[0];
                const date = commit.commit?.committer?.date;
                if (date) {
                    return { date, sha: commit.sha };
                }
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * Get the latest commit SHA of the configured branch.
     * Useful for snapshot comparison without walking the tree.
     */
    async getLatestCommitSha() {
        try {
            return await this.getBranchSha(this.branch);
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=gitee-api.js.map