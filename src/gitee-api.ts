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

	/**
	 * Get the latest commit SHA of a branch.
	 */
	async getBranchSha(branch: string): Promise<string> {
		const data = await this.request(`/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`);
		return data.object?.sha;
	}

	/**
	 * Create a new branch from an existing branch or commit SHA.
	 */
	async createBranch(newBranch: string, fromRef: string = 'master'): Promise<void> {
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
		} catch (err: any) {
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

	async getContents(path: string): Promise<GiteeContentItem | GiteeContentItem[]> {
		return this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${this.branch}`);
	}

	async getRaw(path: string): Promise<ArrayBuffer> {
		return this.request(`/repos/${this.owner}/${this.repo}/raw/${apiPath(path)}?ref=${this.branch}`);
	}

	/**
	 * Create a new file. Returns the new blob SHA.
	 */
	async createFile(path: string, content: Uint8Array, message: string): Promise<string> {
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
	async updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<string> {
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
		} catch (err: any) {
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
	async deleteFile(path: string, sha: string, message: string): Promise<void> {
		try {
			await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.branch}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message,
					sha,
				}),
			});
		} catch (err: any) {
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
	async getFileSha(path: string): Promise<string | null> {
		try {
			const data = await this.getContents(path) as GiteeContentItem;
			return data?.sha || null;
		} catch {
			return null;
		}
	}

	/**
	 * Get the last commit for a specific file path.
	 * Returns the committer date as an ISO string.
	 */
	async getLastCommit(path: string): Promise<{ date: string; sha: string } | null> {
		try {
			const commits = await this.request(
				`/repos/${this.owner}/${this.repo}/commits?path=${apiPath(path)}&ref=${this.branch}&per_page=1`
			) as Array<{ sha: string; commit?: { committer?: { date: string } } }>;
			if (Array.isArray(commits) && commits.length > 0) {
				const commit = commits[0];
				const date = commit.commit?.committer?.date;
				if (date) {
					return { date, sha: commit.sha };
				}
			}
			return null;
		} catch {
			return null;
		}
	}
}
