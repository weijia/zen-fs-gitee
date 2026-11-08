import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GiteeAPI } from '../src/gitee-api.js';

describe('GiteeAPI', () => {
	let api: GiteeAPI;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		api = new GiteeAPI({
			token: 'test-token',
			owner: 'test-owner',
			repo: 'test-repo',
			branch: 'main',
		});
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({}),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('getTree calls correct URL', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ tree: [] }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await api.getTree(true);

		const url = fetchSpy.mock.calls[0][0] as string;
		expect(url).toContain('https://gitee.com/api/v5/repos/test-owner/test-repo/git/trees/main');
		expect(url).toContain('recursive=1');
		expect(url).toContain('access_token=test-token');
	});

	it('getContents calls correct URL for file', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ type: 'file', name: 'README.md', path: 'README.md', sha: 'abc', size: 12 }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await api.getContents('/README.md');

		const url = fetchSpy.mock.calls[0][0] as string;
		expect(url).toContain('/repos/test-owner/test-repo/contents/README.md');
		expect(url).toContain('ref=main');
	});

	it('getRaw calls correct URL', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({}),
			json: async () => ({}),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await api.getRaw('/src/index.ts');

		const url = fetchSpy.mock.calls[0][0] as string;
		expect(url).toContain('/repos/test-owner/test-repo/raw/src/index.ts');
	});

	it('createFile sends POST with base64 content', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 201,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ commit: { sha: 'def' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const content = new TextEncoder().encode('hello');
		await api.createFile('/test.txt', content, 'create test');

		const [_url, init] = fetchSpy.mock.calls[0];
		expect(init?.method).toBe('POST');
		const body = JSON.parse(init?.body as string);
		expect(body.message).toBe('create test');
		expect(body.content).toBe('aGVsbG8=');
	});

	it('createFile substitutes \\n for empty content', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 201,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ content: { sha: 'empty-sha' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await api.createFile('/.keep', new Uint8Array(0), 'create empty');

		const [_url, init] = fetchSpy.mock.calls[0];
		const body = JSON.parse(init?.body as string);
		// \n in base64 is "Cg=="
		expect(body.content).toBe('Cg==');
	});

	it('updateFile sends PUT with sha', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ content: { sha: 'new-sha' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const content = new TextEncoder().encode('updated');
		await api.updateFile('/test.txt', content, 'old-sha', 'update test');

		const [_url, init] = fetchSpy.mock.calls[0];
		expect(init?.method).toBe('PUT');
		const body = JSON.parse(init?.body as string);
		expect(body.sha).toBe('old-sha');
	});

	it('updateFile retries with fresh SHA on mismatch', async () => {
		// First PUT fails with SHA mismatch
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 409,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: 'SHA does not match' }),
			text: async () => 'SHA does not match',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// getFileSha GET
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ type: 'file', name: 'test.txt', path: 'test.txt', sha: 'fresh-sha', size: 6 }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// Retry PUT succeeds
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ content: { sha: 'new-sha' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const content = new TextEncoder().encode('updated');
		const result = await api.updateFile('/test.txt', content, 'old-sha', 'update test');
		expect(result).toBe('new-sha');

		// Third call should be the retry PUT with fresh SHA
		const retryInit = fetchSpy.mock.calls[2][1] as RequestInit;
		const retryBody = JSON.parse(retryInit.body as string);
		expect(retryBody.sha).toBe('fresh-sha');
	});

	it('deleteFile sends DELETE with sha', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ commit: { sha: 'commit-sha' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await api.deleteFile('/test.txt', 'file-sha', 'delete test');

		const [_url, init] = fetchSpy.mock.calls[0];
		expect(init?.method).toBe('DELETE');
		const body = JSON.parse(init?.body as string);
		expect(body.sha).toBe('file-sha');
	});

	it('createFile falls back to PUT when POST rejects an existing path (400)', async () => {
		// POST: Gitee 对已存在路径返回 400“文件名已存在”
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 400,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: '文件名已存在' }),
			text: async () => '{"message":"文件名已存在"}',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// getFileSha: 探测到远端已有 sha
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ type: 'file', name: 'test.txt', path: 'test.txt', sha: 'existing-sha', size: 6 }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// PUT: 更新成功
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ content: { sha: 'updated-sha' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const content = new TextEncoder().encode('hello');
		const result = await api.createFile('/.meta/backends/x.json.mtime', content, 'create sidecar');

		expect(result).toBe('updated-sha');
		expect(fetchSpy.mock.calls[0][1]?.method).toBe('POST');
		expect((fetchSpy.mock.calls[1][0] as string)).toContain('/contents/.meta/backends/x.json.mtime');
		expect(fetchSpy.mock.calls[2][1]?.method).toBe('PUT');
		expect(JSON.parse(fetchSpy.mock.calls[2][1]?.body as string).sha).toBe('existing-sha');
	});

	it('getFileSha returns null when Gitee answers 200 with [] (missing path)', async () => {
		// Gitee 对“路径不存在”返回 200 []（不是 404），`data?.sha` 会是 undefined
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => [],
			text: async () => '[]',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await expect(api.getFileSha('/missing.txt')).resolves.toBeNull();
	});

	it('createFile retries POST after 400 when the path is absent and succeeds', async () => {
		// 1) POST → 400「文件新建失败」（Gitee 刚删完时的读侧滞后）
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 400,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: '文件新建失败' }),
			text: async () => '{"message":"文件新建失败"}',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// 2) getFileSha → 200 []（路径确认不存在）
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => [],
			text: async () => '[]',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// 3) 重试 POST → 201 成功
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 201,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ content: { sha: 'created-sha' } }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const result = await api.createFile('/sidecar.mtime', new TextEncoder().encode('123'), 'create');

		expect(result).toBe('created-sha');
		expect(fetchSpy.mock.calls[0][1]?.method).toBe('POST');
		expect(fetchSpy.mock.calls[1][0] as string).toContain('/contents/sidecar.mtime');
		expect(fetchSpy.mock.calls[2][1]?.method).toBe('POST');
	});

	it('createFile throws the original 400 only after retries also fail', async () => {
		const err400 = {
			ok: false,
			status: 400,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: '文件新建失败' }),
			text: async () => '{"message":"文件新建失败"}',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response;
		fetchSpy.mockResolvedValueOnce(err400);            // POST
		fetchSpy.mockResolvedValueOnce({                   // getFileSha → 200 []
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => [],
			text: async () => '[]',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		fetchSpy.mockResolvedValue(err400);                 // 两次重试均 400

		await expect(api.createFile('/new.txt', new TextEncoder().encode('x'), 'create')).rejects.toThrow('Gitee API 400');
		// 1 次首写 + 2 次重试，全部是 POST
		expect(fetchSpy.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(3);
	});

	it('deleteFile treats a concurrently-deleted file as success (same branch probe)', async () => {
		// DELETE: 文件已不在远端，Gitee 用 400“文件新建失败”表达
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 400,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: '文件新建失败' }),
			text: async () => '{"message":"文件新建失败"}',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// 复检：同一分支上确实不存在
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 404,
			headers: new Headers({}),
			json: async () => ({ message: 'Not Found' }),
			text: async () => 'Not Found',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await expect(api.deleteFile('/gone.txt', 'stale-sha', 'delete')).resolves.toBeUndefined();
		expect((fetchSpy.mock.calls[0][0] as string)).toContain('branch=main');
		expect((fetchSpy.mock.calls[1][0] as string)).toContain('ref=main');
	});

	it('deleteFile still throws the original 400 when the file is present after DELETE', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 400,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: '文件新建失败' }),
			text: async () => '{"message":"文件新建失败"}',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
		// 复检：文件仍存在（并发写回/缓存滞后不再影响判断）
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ type: 'file', name: 'x.txt', path: 'x.txt', sha: 'abc', size: 1 }),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await expect(api.deleteFile('/x.txt', 'sha', 'delete')).rejects.toThrow('Gitee API 400');
		expect((fetchSpy.mock.calls[1][0] as string)).toContain('ref=main');
	});

	it('throws on API error', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 404,
			headers: new Headers({}),
			json: async () => ({ message: 'Not Found' }),
			text: async () => 'Not Found',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await expect(api.getContents('/missing')).rejects.toThrow('Gitee API 404');
	});

	it('createBranch sends POST with branch_name and refs', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 201,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({}),
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		await api.createBranch('dev', 'master');

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toContain('/repos/test-owner/test-repo/branches');
		expect(init?.method).toBe('POST');
		const body = JSON.parse(init?.body as string);
		expect(body.branch_name).toBe('dev');
		expect(body.refs).toBe('master');
	});

	it('getLastCommit calls correct URL and returns date', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => [
				{
					sha: 'commit-sha-abc',
					commit: { committer: { date: '2025-03-10T08:00:00+08:00' } },
				},
			],
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const result = await api.getLastCommit('/docs/notes.md');

		expect(result).not.toBeNull();
		expect(result!.date).toBe('2025-03-10T08:00:00+08:00');
		expect(result!.sha).toBe('commit-sha-abc');

		const url = fetchSpy.mock.calls[0][0] as string;
		expect(url).toContain('/repos/test-owner/test-repo/commits');
		expect(url).toContain('path=docs/notes.md');
		expect(url).toContain('ref=main');
		expect(url).toContain('per_page=1');
	});

	it('getLastCommit returns null on empty result', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => [],
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const result = await api.getLastCommit('/empty.md');
		expect(result).toBeNull();
	});

	it('getLastCommit returns null on API error', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 500,
			headers: new Headers({}),
			json: async () => ({ message: 'Server Error' }),
			text: async () => 'Server Error',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const result = await api.getLastCommit('/broken.md');
		expect(result).toBeNull();
	});

	// -----------------------------------------------------------------------
	// getLatestCommitSha
	// -----------------------------------------------------------------------

	it('getLatestCommitSha returns branch SHA', async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ commit: { sha: 'abc123' } }),
			text: async () => '', arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);

		const sha = await api.getLatestCommitSha();
		expect(sha).toBe('abc123');
		// NOTE: getLatestCommitSha -> getBranchSha reads data.commit.sha,
		// so the mock must shape { commit: { sha } }, not { object: { sha } }.
	});

	it('getLatestCommitSha returns null on error', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('Network error'));
		const sha = await api.getLatestCommitSha();
		expect(sha).toBeNull();
	});
});
