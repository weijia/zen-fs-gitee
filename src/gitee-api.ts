import type { GiteeOptions } from './types.js';
import { apiPath, encodeBase64 } from './utils.js';

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

export class GiteeAPI {
	private token: string;
	private owner: string;
	private repo: string;
	private branch: string;
	private baseUrl: string;

	constructor(options: GiteeOptions) {
		this.token = options.token;
		this.owner = options.owner;
		this.repo = options.repo;
		this.branch = options.branch || 'master';
		this.baseUrl = options.baseUrl || 'https://gitee.com/api/v5';
	}

	async request(path: string, init?: RequestInit): Promise<any> {
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
		if (response.status === 204) return undefined;
		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('application/json')) {
			return response.json();
		}
		return response.arrayBuffer();
	}

	async getTree(recursive = true): Promise<GiteeTreeItem[]> {
		const data = await this.request(
			`/repos/${this.owner}/${this.repo}/git/trees/${this.branch}?recursive=${recursive ? 1 : 0}`
		);
		return data.tree || [];
	}

	async getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]> {
		return this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${this.branch}`);
	}

	async getRaw(path: string): Promise<ArrayBuffer> {
		return this.request(`/repos/${this.owner}/${this.repo}/raw/${apiPath(path)}?ref=${this.branch}`);
	}

	async createFile(path: string, content: Uint8Array, message: string): Promise<void> {
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

	async updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<void> {
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

	async deleteFile(path: string, sha: string, message: string): Promise<void> {
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
