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

	it('empty repository produces an initialization hint', async () => {
		fetchSpy
			.mockResolvedValueOnce(jsonError(404)) // tree
			.mockResolvedValueOnce(jsonOk({ default_branch: 'master' })) // repo meta
			.mockResolvedValueOnce(jsonOk([])); // no branches

		const api = newApi('master');
		await expect(api.getTree(true)).rejects.toThrow(/为空（无任何分支\/提交）/);
	});

	it('writing to an empty repository returns an initialization hint', async () => {
		fetchSpy.mockResolvedValueOnce(jsonError(404));

		const api = newApi('master');
		await expect(api.createFile('/a.txt', new Uint8Array([1]), 'Create a.txt'))
			.rejects.toThrow(/无法写入[\s\S]*初始化提交/);
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
