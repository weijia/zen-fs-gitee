import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GiteeAPI } from '../src/gitee-api.js';

type MockInit = { method?: string; body?: string };

function jsonOk(data: unknown, status = 200) {
	return {
		ok: true,
		status,
		headers: new Headers({ 'content-type': 'application/json' }),
		json: async () => data,
		text: async () => JSON.stringify(data),
		arrayBuffer: async () => new ArrayBuffer(0),
	} as Response;
}

function jsonError(status: number, body = '{"message":"Not Found"}') {
	return {
		ok: false,
		status,
		headers: new Headers({ 'content-type': 'application/json' }),
		json: async () => JSON.parse(body),
		text: async () => body,
		arrayBuffer: async () => new ArrayBuffer(0),
	} as Response;
}

const TREE_ITEM = { path: 'a.txt', mode: '100644', type: 'blob', sha: 'abc', size: 1, url: '' };

describe('GiteeAPI branch fallback', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function newApi(branch = 'master') {
		return new GiteeAPI({ token: 'test-token', owner: 'test-owner', repo: 'test-repo', branch });
	}

	it('missing branch falls back to default_branch and logs the fallback', async () => {
		const logs: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(' '));
		});
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree @ master
			.mockResolvedValueOnce(jsonOk({ default_branch: 'main' })) // repo meta
			.mockResolvedValueOnce(jsonOk([{ name: 'main' }])) // branch list
			.mockResolvedValueOnce(jsonOk({ tree: [TREE_ITEM] })); // tree @ main

		const api = newApi('master');
		const tree = await api.getTree(true);

		expect(tree).toHaveLength(1);
		expect(tree[0].path).toBe('a.txt');
		expect(api.currentBranch).toBe('main');
		expect(api.fellBackToDefaultBranch).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(4);
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(urls[3]).toContain('/git/trees/main');
		expect(logs.join('\n')).toContain("已回落到默认分支 'main'");
		// The raw token must never be logged.
		expect(logs.join('\n')).not.toContain('test-token');
	});

	it('existing branch does not query repository metadata', async () => {
		fetchSpy.mockResolvedValueOnce(jsonOk({ tree: [] }));

		const api = newApi('master');
		await api.getTree(true);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(api.fellBackToDefaultBranch).toBe(false);
		expect(api.currentBranch).toBe('master');
	});

	it('missing repository produces a readable error, not a raw 404', async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree
			.mockResolvedValueOnce(jsonError(404)); // repo meta

		const api = newApi('master');
		await expect(api.getTree(true)).rejects.toThrow(/不存在或无权访问/);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('empty repository is bootstrapped with an initial commit, then the tree is readable', async () => {
		const logs: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(' '));
		});
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree
			.mockResolvedValueOnce(jsonOk({ default_branch: null })) // repo meta (empty repo)
			.mockResolvedValueOnce(jsonOk([])) // no branches
			.mockResolvedValueOnce(jsonOk({ content: { sha: 'init-sha' } }, 201)) // POST .keep
			.mockResolvedValueOnce(jsonOk({ tree: [TREE_ITEM] })); // tree after init

		const api = newApi('master');
		const tree = await api.getTree(true);

		expect(tree).toHaveLength(1);
		expect(api.currentBranch).toBe('master');
		expect(api.autoInitializedEmptyRepo).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(5);

		const post = fetchSpy.mock.calls[3];
		expect(String(post[0])).toContain('/contents/.keep');
		expect(String(post[0])).toContain('branch=master');
		expect((post[1] as MockInit)?.method).toBe('POST');
		const body = JSON.parse(String((post[1] as MockInit)?.body));
		expect(body.message).toBe('chore: 初始化仓库（zen-fs 自动创建）');
		const decoded = Buffer.from(body.content, 'base64').toString('utf8');
		expect(decoded).toBe('');

		expect(logs.join('\n')).toContain('仓库为空，已自动创建初始提交（分支 master）');
		expect(logs.join('\n')).not.toContain('test-token');
	});

	it('retries the initialization write with a single newline when empty content is rejected', async () => {
		const logs: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(' '));
		});
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree
			.mockResolvedValueOnce(jsonOk({ default_branch: null })) // repo meta (empty repo)
			.mockResolvedValueOnce(jsonOk([])) // no branches
			.mockResolvedValueOnce(jsonError(400, '{"message":"content is empty"}')) // POST .keep (empty)
			.mockResolvedValueOnce(jsonOk({ content: { sha: 'init-sha' } }, 201)) // POST .keep (newline)
			.mockResolvedValueOnce(jsonOk({ tree: [TREE_ITEM] })); // tree after init

		const api = newApi('master');
		const tree = await api.getTree(true);

		expect(tree).toHaveLength(1);
		expect(api.currentBranch).toBe('master');
		expect(api.autoInitializedEmptyRepo).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(6);

		const posts = fetchSpy.mock.calls.filter((c) => (c[1] as MockInit)?.method === 'POST');
		expect(posts).toHaveLength(2);
		const first = JSON.parse(String((posts[0][1] as MockInit)?.body));
		const second = JSON.parse(String((posts[1][1] as MockInit)?.body));
		expect(Buffer.from(first.content, 'base64').toString('utf8')).toBe('');
		expect(Buffer.from(second.content, 'base64').toString('utf8')).toBe('\n');
		expect(second.message).toBe('chore: 初始化仓库（zen-fs 自动创建）');
		expect(String(posts[1][0])).toContain('/contents/.keep');
		expect(String(posts[1][0])).toContain('branch=master');

		expect(logs.join('\n')).toContain('仓库为空，已自动创建初始提交（分支 master）');
		expect(logs.join('\n')).not.toContain('test-token');
	});

	it('existing branches never trigger an initialization write', async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree @ master
			.mockResolvedValueOnce(jsonOk({ default_branch: 'main' })) // repo meta
			.mockResolvedValueOnce(jsonOk([{ name: 'main' }])) // branch exists
			.mockResolvedValueOnce(jsonOk({ tree: [] })); // tree @ main

		const api = newApi('master');
		await api.getTree(true);

		const posts = fetchSpy.mock.calls.filter((c) => (c[1] as MockInit)?.method === 'POST');
		expect(posts).toHaveLength(0);
		expect(api.autoInitializedEmptyRepo).toBe(false);
	});

	it('403 on initialization surfaces a readable error and never retries the write', async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree
			.mockResolvedValueOnce(jsonOk({ default_branch: null })) // repo meta
			.mockResolvedValueOnce(jsonOk([])) // no branches
			.mockResolvedValueOnce(jsonError(403, '{"message":"Forbidden"}'))
			// second getTree round
			.mockResolvedValueOnce(jsonError(404))
			.mockResolvedValueOnce(jsonOk({ default_branch: null }))
			.mockResolvedValueOnce(jsonOk([]));

		const api = newApi('master');
		await expect(api.getTree(true)).rejects.toThrow(/缺少写入权限|projects/);
		await expect(api.getTree(true)).rejects.toThrow(/缺少写入权限|projects/);

		const posts = fetchSpy.mock.calls.filter((c) => (c[1] as MockInit)?.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(api.autoInitializedEmptyRepo).toBe(false);
	});

	it('reports a readable error when the tree is still 404 after initialization', async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree
			.mockResolvedValueOnce(jsonOk({ default_branch: null })) // repo meta
			.mockResolvedValueOnce(jsonOk([])) // no branches
			.mockResolvedValueOnce(jsonOk({ content: { sha: 'init-sha' } }, 201)) // POST README
			.mockResolvedValueOnce(jsonError(404)); // tree retry still 404

		const api = newApi('master');
		await expect(api.getTree(true)).rejects.toThrow(/自动初始化后仍无法读取文件树/);
	});

	it('never logs the token, even when an error body echoes it', async () => {
		const logs: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(' '));
		});
		fetchSpy.mockResolvedValueOnce(jsonError(500, '{"message":"boom test-token"}'));

		const api = newApi('master');
		await expect(api.request('/boom')).rejects.toThrow(/boom/);
		expect(logs.join('\n')).not.toContain('test-token');
	});

	it('writing to an empty repository returns a readable error pointing at the init failure', async () => {
		fetchSpy.mockResolvedValueOnce(jsonError(404));

		const api = newApi('master');
		await expect(api.createFile('/a.txt', new Uint8Array([1]), 'Create a.txt'))
			.rejects.toThrow(/无法写入[\s\S]*自动初始化未完成/);
	});

	it('falls back only once and reuses the default branch for later calls', async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree @ master
			.mockResolvedValueOnce(jsonOk({ default_branch: 'main' }))
			.mockResolvedValueOnce(jsonOk([{ name: 'main' }]))
			.mockResolvedValueOnce(jsonOk({ tree: [] })) // tree @ main
			.mockResolvedValueOnce(jsonOk([])); // later raw @ main

		const api = newApi('master');
		await api.getTree(true);
		await api.getRaw('/a.txt');

		expect(fetchSpy).toHaveBeenCalledTimes(5);
		const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
		expect(urls[4]).toContain('ref=main');
	});
});
