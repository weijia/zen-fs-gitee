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
    async getContents(path) {
        return this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${this.branch}`);
    }
    async getRaw(path) {
        return this.request(`/repos/${this.owner}/${this.repo}/raw/${apiPath(path)}?ref=${this.branch}`);
    }
    async createFile(path, content, message) {
        await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: encodeBase64(content),
                message,
                branch: this.branch,
            }),
        });
    }
    async updateFile(path, content, sha, message) {
        await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: encodeBase64(content),
                message,
                sha,
                branch: this.branch,
            }),
        });
    }
    async deleteFile(path, sha, message) {
        await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                sha,
                branch: this.branch,
            }),
        });
    }
}
//# sourceMappingURL=gitee-api.js.map