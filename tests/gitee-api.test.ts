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
});
