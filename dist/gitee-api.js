import { apiPath, encodeBase64 } from './utils.js';
export class GiteeAPI {
    token;
    owner;
    repo;
    branch;
    baseUrl;
    constructor(options) {
        this.token = options.token;
        this.owner = options.owner;
        this.repo = options.repo;
        this.branch = options.branch || 'master';
        this.baseUrl = options.baseUrl || 'https://gitee.com/api/v5';
    }
    async request(path, init) {
        const separator = path.includes('?') ? '&' : '?';
        const url = `${this.baseUrl}${path}${separator}access_token=${this.token}`;
        console.log(`[GiteeAPI] request: ${init?.method || 'GET'} ${url}`);
        const response = await fetch(url, init);
        console.log(`[GiteeAPI] response: status=${response.status} url=${response.url} type=${response.headers.get('content-type')}`);
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.log(`[GiteeAPI] ERROR body: ${text.substring(0, 500)}`);
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
    async getTree(recursive = true) {
        const data = await this.request(`/repos/${this.owner}/${this.repo}/git/trees/${this.branch}?recursive=${recursive ? 1 : 0}`);
        return data.tree || [];
    }
    /**
     * Get the latest commit SHA of a branch.
     */
    async getBranchSha(branch) {
        const data = await this.request(`/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`);
        return data.object?.sha;
    }
    /**
     * Create a new branch from an existing branch or commit SHA.
     */
    async createBranch(newBranch, fromRef = 'master') {
        console.log(`[GiteeAPI] creating branch '${newBranch}' from '${fromRef}'`);
        try {
            await this.request(`/repos/${this.owner}/${this.repo}/branches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    branch_name: newBranch,
                    refs: fromRef,
                }),
            });
            console.log(`[GiteeAPI] branch '${newBranch}' created via /branches API`);
            return;
        }
        catch (err) {
            console.log(`[GiteeAPI] /branches API failed: ${err.message}`);
        }
        console.log(`[GiteeAPI] falling back to Contents API to initialize branch '${newBranch}'`);
        const content = btoa('');
        await this.request(`/repos/${this.owner}/${this.repo}/contents/.gitkeep?branch=${newBranch}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content,
                message: `Initialize branch '${newBranch}'`,
            }),
        });
        console.log(`[GiteeAPI] branch '${newBranch}' initialized via Contents API (.gitkeep)`);
    }
    async getContents(path) {
        return this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${this.branch}`);
    }
    async getRaw(path) {
        return this.request(`/repos/${this.owner}/${this.repo}/raw/${apiPath(path)}?ref=${this.branch}`);
    }
    /**
     * Create a new file. Returns the new blob SHA.
     */
    async createFile(path, content, message) {
        const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.branch}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: encodeBase64(content),
                message,
            }),
        });
        return data?.content?.sha || '';
    }
    /**
     * Update an existing file. Returns the new blob SHA.
     * On "SHA does not match" error, fetches the current SHA and retries once.
     */
    async updateFile(path, content, sha, message) {
        try {
            const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.branch}`, {
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
                console.warn(`[GiteeAPI] SHA mismatch for ${path}, refreshing SHA and retrying...`);
                const freshSha = await this.getFileSha(path);
                if (freshSha) {
                    const data = await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.branch}`, {
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
     * Delete a file.
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
                console.warn(`[GiteeAPI] SHA mismatch for delete ${path}, refreshing SHA and retrying...`);
                const freshSha = await this.getFileSha(path);
                if (freshSha) {
                    await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.branch}`, {
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
            throw err;
        }
    }
    /**
     * Get the current blob SHA of a file via the Contents API.
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
    /**
     * Get the last commit for a specific file path.
     * Returns the committer date as an ISO string.
     */
    async getLastCommit(path) {
        try {
            const commits = await this.request(`/repos/${this.owner}/${this.repo}/commits?path=${apiPath(path)}&ref=${this.branch}&per_page=1`);
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
}
//# sourceMappingURL=gitee-api.js.map