import type { GiteeOptions } from './types.js';
import { apiPath, encodeBase64 } from './utils.js';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('GiteeAPI');

/**
 * Verbose (request/response) API tracing. Hidden by default to avoid console
 * spam — enable with: localStorage.setItem('debug:verbose:GiteeAPI', '1')
 */
const VERBOSE_KEY = 'debug:verbose:GiteeAPI';
try {
  if (localStorage.getItem(VERBOSE_KEY) === null) localStorage.setItem(VERBOSE_KEY, '0');
} catch {
  /* localStorage unavailable (Node.js) — stays hidden */
}
function verboseLog(...args: unknown[]): void {
  try {
    if (localStorage.getItem(VERBOSE_KEY) === '1') console.log('[GiteeAPI]', ...args);
  } catch {
    /* ignore */
  }
}

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
export class GiteeAPI {
	private token: string;
	private owner: string;
	private repo: string;
	/** User-configured branch. Never rewritten — fallbacks are runtime-only. */
	private branch: string;
	private baseUrl: string;
	/**
	 * Branch actually used for API calls after a runtime fallback. `null` means
	 * the configured branch. Kept separate from `branch` so the user's config
	 * (and the UI) still shows what they typed.
	 */
	private resolvedBranch: string | null = null;
	/** Raw user-configured branch (may be undefined). Used when bootstrapping an empty repo. */
	private configuredBranch?: string;
	/** Set once auto-initialization succeeded, so it never runs twice on one instance. */
	private autoInitialized = false;
	/** First auto-initialization error; repeated sync rounds rethrow it instead of writing again. */
	private autoInitError: Error | null = null;

	constructor(options: GiteeOptions) {
		this.token = options.token;
		this.owner = options.owner;
		this.repo = options.repo;
		this.configuredBranch = options.branch;
		this.branch = options.branch || 'master';
		this.baseUrl = options.baseUrl || 'https://gitee.com/api/v5';
	}

	/** Branch used by every API call (configured, or the resolved default after a fallback). */
	get currentBranch(): string {
		return this.resolvedBranch ?? this.branch;
	}

	/** True when the configured branch was missing and a default branch was used instead. */
	get fellBackToDefaultBranch(): boolean {
		return this.resolvedBranch !== null && this.resolvedBranch !== this.branch;
	}

	/** True when an empty repository was bootstrapped with an initial commit. */
	get autoInitializedEmptyRepo(): boolean {
		return this.autoInitialized;
	}

	private static httpStatus(err: unknown): number | null {
		const msg = err instanceof Error ? err.message : String(err);
		const match = /Gitee API (\d+)/.exec(msg);
		return match ? Number(match[1]) : null;
	}

	/**
	 * The tree endpoint returns 404 both for "repo missing/no permission" and
	 * "branch missing", so on a 404 ask the repository metadata and branch list
	 * which case we are in.
	 */
	private async readRepoState(): Promise<{ defaultBranch?: string; branchCount: number | null }> {
		let meta: any;
		try {
			meta = await this.request(`/repos/${this.owner}/${this.repo}`);
		} catch (err) {
			if (GiteeAPI.httpStatus(err) === 404) {
				throw new Error(
					`Gitee 仓库 ${this.owner}/${this.repo} 不存在或无权访问（请检查 owner/repo 和 token 权限）`,
				);
			}
			log.log(
				`读取仓库信息失败（${err instanceof Error ? err.message : String(err)}），保留原始分支错误`,
			);
			return { branchCount: null };
		}

		let branchCount: number | null = null;
		try {
			const list = await this.request(`/repos/${this.owner}/${this.repo}/branches`);
			branchCount = Array.isArray(list) ? list.length : null;
		} catch {
			/* fall back to default_branch below */
		}
		return { defaultBranch: meta?.default_branch || undefined, branchCount };
	}

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
	private async initializeEmptyRepository(defaultBranch?: string): Promise<void> {
		if (this.autoInitialized) return;
		if (this.autoInitError) throw this.autoInitError;

		const targetBranch = this.configuredBranch || defaultBranch || 'master';
		const message = 'chore: 初始化仓库（zen-fs 自动创建）';
		const path = `/repos/${this.owner}/${this.repo}/contents/.keep?branch=${targetBranch}`;
		const writeKeep = (content: Uint8Array) =>
			this.request(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: encodeBase64(content), message }),
			});
		const readableError = (err: unknown) => {
			const status = GiteeAPI.httpStatus(err);
			const detail = err instanceof Error ? err.message : String(err);
			return status === 403
				? new Error(
					`Gitee 仓库 ${this.owner}/${this.repo} 为空，自动初始化被拒绝：token 缺少写入权限（需要 projects 读写权限）`,
				)
				: status === 404
					? new Error(
						`Gitee 仓库 ${this.owner}/${this.repo} 不存在或无权访问，无法自动初始化`,
					)
					: new Error(`Gitee 仓库 ${this.owner}/${this.repo} 为空，自动初始化失败：${detail}`);
		};

		try {
			// Prefer a truly empty placeholder file.
			await writeKeep(new Uint8Array(0));
		} catch (err) {
			const status = GiteeAPI.httpStatus(err);
			if (status !== 400 && status !== 422) {
				const readable = readableError(err);
				this.autoInitError = readable;
				throw readable;
			}
			// Gitee can reject an empty `content` field; retry once with a single newline.
			try {
				await writeKeep(new TextEncoder().encode('\n'));
			} catch (retryErr) {
				const readable = readableError(retryErr);
				this.autoInitError = readable;
				throw readable;
			}
		}

		this.autoInitialized = true;
		this.resolvedBranch = targetBranch;
		log.log(`仓库为空，已自动创建初始提交（分支 ${targetBranch}）`);
	}

	async request(path: string, init?: RequestInit, opts?: { quiet404?: boolean }): Promise<any> {
		const separator = path.includes('?') ? '&' : '?';
		const url = `${this.baseUrl}${path}${separator}access_token=${this.token}`;
		// Never let the token leak into logs (verbose tracing or error bodies).
		const mask = (value: string | undefined) =>
			(!value || !this.token ? value ?? '' : value.split(this.token).join('***'));
		verboseLog(`request: ${init?.method || 'GET'} ${mask(url)}`);
		const response = await fetch(url, init);
		verboseLog(`response: status=${response.status} url=${mask(response.url)} type=${response.headers.get('content-type')}`);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			const safeText = mask(text);
			// A 404 can be an expected probe (e.g. "does this .mtime sidecar
			// exist?"). Callers that legitimately expect it pass quiet404 so the
			// console is not flooded with false alarms.
			if (!(opts?.quiet404 && response.status === 404)) {
				log.log(`ERROR body: ${safeText.substring(0, 500)}`);
			}
			throw new Error(`Gitee API ${response.status}: ${safeText}`);
		}
		if (response.status === 204) return undefined;
		const contentType = response.headers.get('content-type') || '';
		if (contentType.includes('application/json')) {
			return response.json();
		}
		return response.arrayBuffer();
	}

	// -----------------------------------------------------------------------
	// Read-only Git Data API (supported by Gitee)
	// -----------------------------------------------------------------------

	async getTree(recursive = true): Promise<GiteeTreeItem[]> {
		const treePath = (branch: string) =>
			`/repos/${this.owner}/${this.repo}/git/trees/${branch}?recursive=${recursive ? 1 : 0}`;
		try {
			const data = await this.request(treePath(this.currentBranch));
			return data.tree || [];
		} catch (err) {
			if (GiteeAPI.httpStatus(err) !== 404) throw err;

			const state = await this.readRepoState();
			if (state.branchCount === 0) {
				// Empty repository: bootstrap it once, then read the freshly created tree.
				await this.initializeEmptyRepository(state.defaultBranch);
				try {
					const data = await this.request(treePath(this.currentBranch));
					return data.tree || [];
				} catch (retryErr) {
					if (GiteeAPI.httpStatus(retryErr) === 404) {
						throw new Error(
							`Gitee 仓库 ${this.owner}/${this.repo} 为空，自动初始化后仍无法读取文件树（分支 '${this.currentBranch}'）`,
						);
					}
					throw retryErr;
				}
			}

			const defaultBranch = state.defaultBranch;
			if (defaultBranch && defaultBranch !== this.branch) {
				log.log(`指定分支 '${this.branch}' 不存在，已回落到默认分支 '${defaultBranch}'`);
				this.resolvedBranch = defaultBranch;
				const data = await this.request(treePath(defaultBranch));
				return data.tree || [];
			}

			log.log(
				`指定分支 '${this.branch}' 不存在，且没有可用的默认分支（仓库未返回 default_branch），保留原始错误`,
			);
			throw err;
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
	async getBranchSha(branch: string = this.currentBranch): Promise<string | null> {
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
	async createBranch(newBranch: string, fromRef: string = 'master'): Promise<void> {
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

	async getContents(path: string, branch: string = this.currentBranch): Promise<GiteeContentItem | GiteeContentItem[]> {
		return this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${branch}`);
	}

	/**
	 * Read a raw file. `quiet404` marks an existence probe (e.g. an `.mtime`
	 * sidecar check) where a 404 is an expected answer, not an error to log.
	 */
	async getRaw(path: string, opts?: { quiet404?: boolean }): Promise<ArrayBuffer> {
		return this.request(
			`/repos/${this.owner}/${this.repo}/raw/${apiPath(path)}?ref=${this.currentBranch}`,
			undefined,
			opts,
		);
	}

	/**
	 * Create a new file via Contents API. Returns the new blob SHA.
	 * Gitee rejects empty content with "content is empty", so empty files
	 * are stored as a single newline `\n` (1 byte).
	 * Callers should be aware that 0-byte files become 1-byte on Gitee.
	 */
	async createFile(path: string, content: Uint8Array, message: string): Promise<string> {
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
		} catch (err) {
			const status = GiteeAPI.httpStatus(err);
			if (status === 403) {
				throw new Error(
					`Gitee 仓库 ${this.owner}/${this.repo} 无法写入：token 缺少写入权限（需要 projects 读写权限）`,
				);
			}
			if (status === 404) {
				throw new Error(
					`Gitee 仓库 ${this.owner}/${this.repo} 无法写入：分支 '${this.currentBranch}' 不存在或仓库为空`
					+ '（自动初始化未完成，请查看同步日志中的初始化错误）',
				);
			}
			// Gitee 对 POST 创建“已存在路径”返回 400（中文措辞“文件名已存在”/
			// “文件新建失败”）。本地 shaCache 是冷的（例如刚被 sidecar 清理删掉，
			// 或其它设备/实例已先写过该路径）时，写 sidecar/元数据必然走 POST。
			// 这里先取远端 sha，存在则改走 PUT 更新，避免把 400 抛给同步/激活流程。
			if (status === 400) {
				const existingSha = await this.getFileSha(path);
				if (existingSha) {
					verboseLog(`createFile: ${path} already exists remotely, retrying as PUT update`);
					return this.updateFile(path, content, existingSha, message);
				}
			}
			throw err;
		}
	}

	/**
	 * Update an existing file via Contents API. Returns the new blob SHA.
	 * On "SHA does not match" error, fetches the current SHA and retries once.
	 * Gitee rejects empty content — empty files are stored as `\n`.
	 */
	async updateFile(path: string, content: Uint8Array, sha: string, message: string): Promise<string> {
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
		} catch (err: any) {
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
	async deleteFile(path: string, sha: string, message: string): Promise<void> {
		try {
			await this.request(`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?branch=${this.currentBranch}`, {
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
			// 复检必须与上面的 DELETE 用同一分支（currentBranch），并且直接走
			// request（quiet404），不经任何上层内容缓存，否则并发删除/缓存滞后
			// 会把“已不存在”误判成“仍存在”再抛出原始 400。
			const stillExists = await this.request(
				`/repos/${this.owner}/${this.repo}/contents/${apiPath(path)}?ref=${this.currentBranch}`,
				undefined,
				{ quiet404: true },
			).then(() => true).catch(() => false);
			if (!stillExists) return;
			throw err;
		}
	}

	/**
	 * Get the current blob SHA of a file via the Contents API (GET).
	 */
	async getFileSha(path: string): Promise<string | null> {
		try {
			const data = await this.getContents(path) as GiteeContentItem;
			return data?.sha || null;
		} catch {
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
	async getLastCommit(path: string): Promise<{ date: string; sha: string } | null> {
		try {
			const commits = await this.request(
				`/repos/${this.owner}/${this.repo}/commits?path=${apiPath(path)}&ref=${this.currentBranch}&per_page=1`
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

	/**
	 * Get the latest commit SHA of the configured branch.
	 * Useful for snapshot comparison without walking the tree.
	 */
	async getLatestCommitSha(): Promise<string | null> {
		try {
			return await this.getBranchSha(this.branch);
		} catch {
			return null;
		}
	}
}
