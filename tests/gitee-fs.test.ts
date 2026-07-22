import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GiteeFS } from '../src/gitee-fs.js';
import { S_IFREG, S_IFDIR } from '@zenfs/core/constants';

describe('GiteeFS', () => {
	let fs: GiteeFS;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	function mockTreeResponse(tree: any[]) {
		return {
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ tree }),
			text: async () => JSON.stringify({ tree }),
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response;
	}

	function mockRawResponse(text: string) {
		return {
			ok: true,
			status: 200,
			headers: new Headers({}),
			json: async () => ({}),
			text: async () => text,
			arrayBuffer: async () => new TextEncoder().encode(text),
		} as Response;
	}

	function mockOkJson(data: any) {
		return {
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => data,
			text: async () => JSON.stringify(data),
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response;
	}

	beforeEach(() => {
		fs = new GiteeFS({
			token: 'test-token',
			owner: 'test-owner',
			repo: 'test-repo',
			branch: 'main',
		});
		fetchSpy = vi.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('init', () => {
		it('builds index from tree', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'src', type: 'tree', sha: 'tree-sha-1', mode: '040000' },
				{ path: 'src/index.ts', type: 'blob', sha: 'blob-sha-1', size: 42, mode: '100644' },
				{ path: 'README.md', type: 'blob', sha: 'blob-sha-2', size: 12, mode: '100644' },
			]));

			await fs.init();

			expect(fs.index.has('/')).toBe(true);
			expect(fs.index.has('/src')).toBe(true);
			expect(fs.index.has('/src/index.ts')).toBe(true);
			expect(fs.index.has('/README.md')).toBe(true);

			const srcNode = fs.index.get('/src')!;
			expect((srcNode.mode & S_IFDIR) === S_IFDIR).toBe(true);

			const fileNode = fs.index.get('/src/index.ts')!;
			expect(fileNode.size).toBe(42);
			expect((fileNode.mode & S_IFREG) === S_IFREG).toBe(true);

			expect(fs.shaCache.get('/src/index.ts')).toBe('blob-sha-1');
			expect(fs.shaCache.get('/README.md')).toBe('blob-sha-2');
		});

		it('creates root if tree is empty', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();
			expect(fs.index.has('/')).toBe(true);
		});
	});

	describe('read', () => {
		it('fetches and caches file content', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'test.txt', type: 'blob', sha: 'abc', size: 5, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockRawResponse('hello'));
			const buffer = new Uint8Array(5);
			await fs.read('/test.txt', buffer, 0, 5);

			expect(new TextDecoder().decode(buffer)).toBe('hello');
			expect(fs.contentCache.has('/test.txt')).toBe(true);
		});

		it('reads from cache on second call', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'test.txt', type: 'blob', sha: 'abc', size: 5, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockRawResponse('hello'));
			const buf1 = new Uint8Array(5);
			await fs.read('/test.txt', buf1, 0, 5);

			const buf2 = new Uint8Array(5);
			await fs.read('/test.txt', buf2, 0, 5);

			expect(fetchSpy).toHaveBeenCalledTimes(2); // tree + 1 raw
		});

		it('supports partial reads', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'test.txt', type: 'blob', sha: 'abc', size: 5, mode: '100644' },
			]));
			await fs.init();

			fs.contentCache.set('/test.txt', new TextEncoder().encode('hello'));
			const buffer = new Uint8Array(2);
			await fs.read('/test.txt', buffer, 1, 3);

			expect(new TextDecoder().decode(buffer)).toBe('el');
		});
	});

	describe('readSync', () => {
		it('reads from cache', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'test.txt', type: 'blob', sha: 'abc', size: 5, mode: '100644' },
			]));
			await fs.init();

			fs.contentCache.set('/test.txt', new TextEncoder().encode('hello'));
			const buffer = new Uint8Array(5);
			fs.readSync('/test.txt', buffer, 0, 5);
			expect(new TextDecoder().decode(buffer)).toBe('hello');
		});

		it('throws EAGAIN if not cached', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'test.txt', type: 'blob', sha: 'abc', size: 5, mode: '100644' },
			]));
			await fs.init();

			const buffer = new Uint8Array(5);
			expect(() => fs.readSync('/test.txt', buffer, 0, 5)).toThrow();
		});
	});

	describe('write', () => {
		it('creates new file via POST', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();

			// createFile to add to index
			fs.createFileSync('/new.txt', { mode: 0o644, uid: 0, gid: 0 });

			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-sha' } }));
			const data = new TextEncoder().encode('world');
			await fs.write('/new.txt', data, 0);

			const [_url, init] = fetchSpy.mock.calls[1];
			expect(init?.method).toBe('POST');
			expect(fs.contentCache.get('/new.txt')!).toEqual(data);
		});

		it('updates existing file via PUT', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'exist.txt', type: 'blob', sha: 'old-sha', size: 3, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-sha' } }));
			const data = new TextEncoder().encode('xyz');
			await fs.write('/exist.txt', data, 0);

			const [_url, init] = fetchSpy.mock.calls[1];
			expect(init?.method).toBe('PUT');
			const body = JSON.parse(init?.body as string);
			expect(body.sha).toBe('old-sha');
		});
	});

	describe('writeSync', () => {
		it('updates cache and queues background write', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();

			fs.createFileSync('/sync.txt', { mode: 0o644, uid: 0, gid: 0 });

			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-sha' } }));
			const data = new TextEncoder().encode('sync-data');
			fs.writeSync('/sync.txt', data, 0);

			expect(fs.contentCache.get('/sync.txt')!).toEqual(data);
			// Wait for background queue to drain
			await fs.sync();
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe('remove / removeSync', () => {
		it('deletes file via API', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'del.txt', type: 'blob', sha: 'del-sha', size: 1, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockOkJson({ commit: { sha: 'c' } }));
			await fs.remove('/del.txt');

			expect(fs.shaCache.has('/del.txt')).toBe(false);
			expect(fs.contentCache.has('/del.txt')).toBe(false);
		});

		it('removeSync queues background delete', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'del.txt', type: 'blob', sha: 'del-sha', size: 1, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockOkJson({ commit: { sha: 'c' } }));
			fs.removeSync('/del.txt');

			expect(fs.contentCache.has('/del.txt')).toBe(false);
			await fs.sync();
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe('readdir', () => {
		it('lists directory entries', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'src', type: 'tree', sha: 't1', mode: '040000' },
				{ path: 'src/a.ts', type: 'blob', sha: 'b1', size: 1, mode: '100644' },
				{ path: 'src/b.ts', type: 'blob', sha: 'b2', size: 1, mode: '100644' },
				{ path: 'README.md', type: 'blob', sha: 'b3', size: 1, mode: '100644' },
			]));
			await fs.init();

			const entries = fs.readdirSync('/src');
			expect(entries).toContain('a.ts');
			expect(entries).toContain('b.ts');
		});
	});

	describe('stat', () => {
		it('returns inode for file', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'file.txt', type: 'blob', sha: 'abc', size: 123, mode: '100644' },
			]));
			await fs.init();

			const inode = fs.statSync('/file.txt');
			expect(inode.size).toBe(123);
			expect((inode.mode & S_IFREG) === S_IFREG).toBe(true);
		});

		it('throws ENOENT for missing path', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();

			expect(() => fs.statSync('/missing')).toThrow();
		});

		it('async stat fetches last commit date for files', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
			]));
			await fs.init();

			// Mock getLastCommit API response
			fetchSpy.mockResolvedValueOnce(mockOkJson([
				{
					sha: 'commit-sha-1',
					commit: { committer: { date: '2025-01-15T10:30:00+08:00' } },
				},
			]));

			const inode = await fs.stat('/notes.md');
			expect(inode.size).toBe(50);
			expect(inode.mtimeMs).toBe(new Date('2025-01-15T10:30:00+08:00').getTime());

			// Should be cached in mtimeCache
			expect(fs.mtimeCache.get('/notes.md')).toEqual({
				sha: 'sha1',
				lastModified: '2025-01-15T10:30:00+08:00',
			});
		});

		it('async stat uses cached mtime on second call', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockOkJson([
				{
					sha: 'commit-sha-1',
					commit: { committer: { date: '2025-01-15T10:30:00+08:00' } },
				},
			]));

			const inode1 = await fs.stat('/notes.md');
			expect(inode1.mtimeMs).toBe(new Date('2025-01-15T10:30:00+08:00').getTime());

			// Second call should NOT trigger another fetch (cached)
			const inode2 = await fs.stat('/notes.md');
			expect(inode2.mtimeMs).toBe(new Date('2025-01-15T10:30:00+08:00').getTime());

			// fetchSpy: 1 (tree) + 1 (getLastCommit) = 2 total
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});

		it('async stat re-fetches mtime when SHA changes', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
			]));
			await fs.init();

			// First stat
			fetchSpy.mockResolvedValueOnce(mockOkJson([
				{
					sha: 'commit-1',
					commit: { committer: { date: '2025-01-15T10:30:00+08:00' } },
				},
			]));
			await fs.stat('/notes.md');

			// Simulate SHA change (e.g. remote update)
			fs.shaCache.set('/notes.md', 'sha2');

			// Second stat should fetch new commit date
			fetchSpy.mockResolvedValueOnce(mockOkJson([
				{
					sha: 'commit-2',
					commit: { committer: { date: '2025-06-20T14:00:00+08:00' } },
				},
			]));
			const inode = await fs.stat('/notes.md');
			expect(inode.mtimeMs).toBe(new Date('2025-06-20T14:00:00+08:00').getTime());
			expect(fs.mtimeCache.get('/notes.md')!.sha).toBe('sha2');
		});

		it('async stat returns inode as-is for directories', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'src', type: 'tree', sha: 'tree-sha', mode: '040000' },
			]));
			await fs.init();

			const inode = await fs.stat('/src');
			expect((inode.mode & S_IFDIR) === S_IFDIR).toBe(true);
			});

		it('async stat falls back gracefully when getLastCommit fails', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
			]));
			await fs.init();

			// Mock API error
			fetchSpy.mockResolvedValueOnce({
				ok: false,
				status: 500,
				headers: new Headers({}),
				json: async () => ({ message: 'Internal Server Error' }),
				text: async () => 'Internal Server Error',
				arrayBuffer: async () => new ArrayBuffer(0),
			} as Response);

			const inode = await fs.stat('/notes.md');
			// Should still return inode with default mtime
			expect(inode.size).toBe(50);
		});
	});

	describe('getFileSha', () => {
		it('returns SHA for known file', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'test.txt', type: 'blob', sha: 'file-sha-123', size: 10, mode: '100644' },
			]));
			await fs.init();

			expect(fs.getFileSha('/test.txt')).toBe('file-sha-123');
		});

		it('returns undefined for unknown file', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();

			expect(fs.getFileSha('/nope.txt')).toBeUndefined();
		});
	});
});
