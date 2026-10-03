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

	function mockNotFound(): Response {
		return {
			ok: false,
			status: 404,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => ({ message: 'Not Found' }),
			text: async () => 'Not Found',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response;
	}

	let repoCounter = 0;
	beforeEach(() => {
		repoCounter++;
		fs = new GiteeFS({
			token: 'test-token',
			owner: 'test-owner',
			repo: `test-repo-${repoCounter}`,
			branch: 'main',
		});
		// Skip the incidental shouldSync baseline fetch inside init() so unit
		// tests don't have to account for an extra getLatestCommitSha() call.
		// (Seeding lastCommitSha directly doesn't work because loadFromIDB()
		// resets it from IndexedDB during init(), so stub the API method.)
		fs.api.getLatestCommitSha = async () => null;
		fetchSpy = vi.spyOn(globalThis, 'fetch');
		// Default benign response for any fetch not explicitly mocked. This keeps
		// incidental calls (mtime sidecar getRaw / getLastCommit fallbacks) from
		// hitting the network and lets them resolve instantly.
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers({ 'content-type': 'application/json' }),
			json: async () => [],
			text: async () => '',
			arrayBuffer: async () => new ArrayBuffer(0),
		} as Response);
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

		it('skips data-file write when content is unchanged (only mtime differs)', async () => {
			const data = new TextEncoder().encode('xyz');
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'exist.txt', type: 'blob', sha: 'old-sha', size: 3, mode: '100644' },
			]));
			await fs.init();
			// Simulate the sync engine having preloaded the remote content.
			fs.contentCache.set('/exist.txt', data);

			const writtenPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') writtenPaths.push(String(url));
				return Promise.resolve(mockOkJson({ content: { sha: 's' } }) as Response);
			});

			await fs.write('/exist.txt', data, 0, 1700000000999);

			// Data file unchanged → no data PUT; only the .mtime sidecar is written.
			expect(writtenPaths.some((u) => u.includes('exist.txt') && !u.includes('.mtime'))).toBe(false);
			expect(writtenPaths.some((u) => u.includes('exist.txt.mtime'))).toBe(true);
			// Existing blob SHA is preserved.
			expect(fs.shaCache.get('/exist.txt')).toBe('old-sha');
		});

		it('writes data file when content is not cached (conservative on cache miss)', async () => {
			const data = new TextEncoder().encode('xyz');
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'exist.txt', type: 'blob', sha: 'old-sha', size: 3, mode: '100644' },
			]));
			await fs.init();
			// No contentCache seed → unknown content → must write data file.

			const writtenPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') writtenPaths.push(String(url));
				return Promise.resolve(mockOkJson({ content: { sha: 'new-sha' } }) as Response);
			});

			await fs.write('/exist.txt', data, 0, 1700000000999);

			expect(writtenPaths.some((u) => u.includes('exist.txt') && !u.includes('.mtime'))).toBe(true);
			expect(fs.shaCache.get('/exist.txt')).toBe('new-sha');
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
			// 1 (tree) + 1 (data write) + 1 (mtime sidecar write) = 3
			expect(fetchSpy).toHaveBeenCalledTimes(3);
		});

		it('skips data-file write when content is unchanged (only mtime differs)', async () => {
			const data = new TextEncoder().encode('sync-data');
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();
			fs.createFileSync('/sync.txt', { mode: 0o644, uid: 0, gid: 0 });
			fs.shaCache.set('/sync.txt', 'old-sha');
			// Simulate the sync engine having preloaded the remote content.
			fs.contentCache.set('/sync.txt', data);

			const writtenPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') writtenPaths.push(String(url));
				return Promise.resolve(mockOkJson({ content: { sha: 's' } }) as Response);
			});

			fs.writeSync('/sync.txt', data, 0, 1700000000999);
			await fs.sync();

			// Data file unchanged → no data write; only the .mtime sidecar queued.
			expect(writtenPaths.some((u) => u.includes('sync.txt') && !u.includes('.mtime'))).toBe(false);
			expect(writtenPaths.some((u) => u.includes('sync.txt.mtime'))).toBe(true);
			expect(fs.shaCache.get('/sync.txt')).toBe('old-sha');
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
			// 1 (tree) + 1 (data delete); no sidecar exists in the tree, so the
			// sidecar delete is skipped.
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

		it('hides internal .keep placeholder from async readdir', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'src', type: 'tree', sha: 't1', mode: '040000' },
				{ path: 'src/.keep', type: 'blob', sha: 'k1', size: 1, mode: '100644' },
				{ path: 'src/a.ts', type: 'blob', sha: 'b1', size: 1, mode: '100644' },
			]));
			await fs.init();

			const entries = await fs.readdir('/src');
			expect(entries).toContain('a.ts');
			expect(entries).not.toContain('.keep');
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

		// No sidecar in tree, so stat() calls getRaw(sidecar) first (which
		// 404s / returns nothing) and then falls through to the Commits API.
		// Queue the getRaw response BEFORE getLastCommit so the latter isn't
		// consumed by the former.
		fetchSpy.mockResolvedValueOnce(mockRawResponse(''));
		fetchSpy.mockResolvedValueOnce(mockOkJson([
			{
				sha: 'commit-sha-1',
				commit: { committer: { date: '2025-01-15T10:30:00+08:00' } },
			},
		]));

		const inode = await fs.stat('/notes.md');
		expect(inode.size).toBe(50);
		expect(inode.mtimeMs).toBe(new Date('2025-01-15T10:30:00+08:00').getTime());

		// Should be cached in mtimeCache (commit-time, not from sidecar)
		expect(fs.mtimeCache.get('/notes.md')).toEqual({
			sha: 'sha1',
			lastModified: '2025-01-15T10:30:00+08:00',
			fromSidecar: false,
		});
	});

		it('async stat re-fetches last commit date on each call when no sidecar is present', async () => {
		fetchSpy.mockResolvedValueOnce(mockTreeResponse([
			{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
		]));
		await fs.init();

		// No sidecar in tree, so stat() goes to the Commits API on every call.
		// Commit-time mtime is intentionally NOT cached (a cached commit time
		// with no sidecar confirmation caused an endless MTIME NORMALIZE loop),
		// so each stat re-fetches it.
		const commitMock = mockOkJson([
			{
				sha: 'commit-sha-1',
				commit: { committer: { date: '2025-01-15T10:30:00+08:00' } },
			},
		]);
		// stat() calls getRaw(sidecar) before getLastCommit on every call, so
		// queue an empty getRaw response ahead of each getLastCommit mock.
		fetchSpy.mockResolvedValueOnce(mockRawResponse(''));
		fetchSpy.mockResolvedValueOnce(commitMock);
		fetchSpy.mockResolvedValueOnce(mockRawResponse(''));
		fetchSpy.mockResolvedValueOnce(commitMock);

		const inode1 = await fs.stat('/notes.md');
		expect(inode1.mtimeMs).toBe(new Date('2025-01-15T10:30:00+08:00').getTime());

		const inode2 = await fs.stat('/notes.md');
		expect(inode2.mtimeMs).toBe(new Date('2025-01-15T10:30:00+08:00').getTime());
	});

		it('async stat re-fetches mtime when SHA changes', async () => {
		fetchSpy.mockResolvedValueOnce(mockTreeResponse([
			{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
		]));
		await fs.init();

		// Stub getLastCommit directly to avoid fetch-queue ordering issues;
		// getRaw(sidecar) falls through to this stub via the default mock.
		const commit1 = '2025-01-15T10:30:00+08:00';
		const commit2 = '2025-06-20T14:00:00+08:00';
		let currentCommit = commit1;
		fs.api.getLastCommit = async () => ({ date: currentCommit, sha: 'commit-sha' });

		await fs.stat('/notes.md');

		// Simulate SHA change (e.g. remote update)
		fs.shaCache.set('/notes.md', 'sha2');
		currentCommit = commit2;

		const inode = await fs.stat('/notes.md');
		expect(inode.mtimeMs).toBe(new Date(commit2).getTime());
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

		// No sidecar in tree, so stat() goes to Commits API (which fails)
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

	it('async stat reads mtime from sidecar file when present', async () => {
		const testMtime = 1700000000123;
		fetchSpy.mockResolvedValueOnce(mockTreeResponse([
			{ path: 'notes.md', type: 'blob', sha: 'sha1', size: 50, mode: '100644' },
			{ path: 'notes.md.mtime', type: 'blob', sha: 'sidecar-sha', size: 13, mode: '100644' },
		]));
		await fs.init();

		// stat() reads sidecar and gets the mtime value
		fetchSpy.mockResolvedValueOnce(mockRawResponse(String(testMtime)));

		const inode = await fs.stat('/notes.md');
		expect(inode.mtimeMs).toBe(testMtime);

		// Should NOT call Commits API (sidecar takes priority)
		// fetchSpy: 1 (tree) + 1 (sidecar raw) = 2 total
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('init skips sidecar files from index but caches their SHA', async () => {
		fetchSpy.mockResolvedValueOnce(mockTreeResponse([
			{ path: 'config.json', type: 'blob', sha: 'data-sha', size: 100, mode: '100644' },
			{ path: 'config.json.mtime', type: 'blob', sha: 'sidecar-sha', size: 13, mode: '100644' },
		]));
		await fs.init();

		// Data file should be in index
		expect(fs.index.has('/config.json')).toBe(true);
		// Sidecar should NOT be in index
		expect(fs.index.has('/config.json.mtime')).toBe(false);
		// But sidecar SHA should be cached
		expect(fs.shaCache.get('/config.json.mtime')).toBe('sidecar-sha');
	});

	it('remove deletes both data file and sidecar separately via Contents API', async () => {
		fetchSpy.mockResolvedValueOnce(mockTreeResponse([
			{ path: 'config.json', type: 'blob', sha: 'data-sha', size: 100, mode: '100644' },
			{ path: 'config.json.mtime', type: 'blob', sha: 'sidecar-sha', size: 13, mode: '100644' },
		]));
		await fs.init();

		// Mock the two separate deleteFile calls via Contents API:
		// 1. deleteFile (data file config.json) -> returns { commit: { sha } }
		// 2. deleteFile (sidecar config.json.mtime) -> returns { commit: { sha } }
		fetchSpy.mockResolvedValueOnce(mockOkJson({ commit: { sha: 'commit-sha' } }));
		fetchSpy.mockResolvedValueOnce(mockOkJson({ commit: { sha: 'commit-sha' } }));

		await fs.remove('/config.json');

		// Both SHAs should be removed from cache
		expect(fs.shaCache.has('/config.json')).toBe(false);
		expect(fs.shaCache.has('/config.json.mtime')).toBe(false);
		expect(fs.contentCache.has('/config.json')).toBe(false);
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

	describe('writeFileWithMtime', () => {
		it('writes data file and sidecar in separate Contents API calls', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'config.json', type: 'blob', sha: 'old-sha', size: 50, mode: '100644' },
			]));
			await fs.init();

			const testMtime = 1700000000123;
			const testData = '{"key":"value"}';

			// The init tree has config.json with sha 'old-sha', so writeFileWithMtime
			// calls updateFile for the data file (returns content.sha). No sidecar
			// exists in the tree, so it calls createFile for the sidecar (returns
			// content.sha). Each Contents API call is exactly one fetch.
			// 1. updateFile (data file config.json) -> { content: { sha: 'new-data-sha' } }
			// 2. createFile (sidecar config.json.mtime) -> { content: { sha: 'new-sidecar-sha' } }
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-data-sha' } }));
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-sidecar-sha' } }));

			await fs.writeFileWithMtime('/config.json', testData, testMtime);

			// Content cache should be updated
			const cached = fs.contentCache.get('/config.json');
			expect(cached).toBeDefined();
			expect(new TextDecoder().decode(cached!)).toBe(testData);

			// Sidecar content should be cached
			const sidecarCached = fs.contentCache.get('/config.json.mtime');
			expect(sidecarCached).toBeDefined();
			expect(new TextDecoder().decode(sidecarCached!)).toBe(String(testMtime));

			// SHA caches should be updated with the SHAs returned by the Contents API
			expect(fs.shaCache.get('/config.json')).toBe('new-data-sha');
			expect(fs.shaCache.get('/config.json.mtime')).toBe('new-sidecar-sha');
		});

		it('accepts Uint8Array data', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();

			const testMtime = 1700000000456;
			const testData = new TextEncoder().encode('binary data');

			// Empty tree (no existing files), so both data and sidecar use createFile.
			// 1. createFile (data file binary.dat) -> { content: { sha: 'data-sha' } }
			// 2. createFile (sidecar binary.dat.mtime) -> { content: { sha: 'sidecar-sha' } }
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'data-sha' } }));
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'sidecar-sha' } }));

			await fs.writeFileWithMtime('/binary.dat', testData, testMtime);

			expect(fs.shaCache.get('/binary.dat')).toBe('data-sha');
			expect(fs.shaCache.get('/binary.dat.mtime')).toBe('sidecar-sha');
			});

			// ---------------------------------------------------------------------------
			// Bug repro: writeFileWithMtime must record the sidecar as *authoritative*
			// (fromSidecar:true) in mtimeCache AND clear noSidecarCache. Without this,
			// the next stat() trusts the Commits API commit time instead of the
			// preserved mtime → MTIME NORMALIZE loop (identical content re-PUT every
			// sync cycle, target mtime never stabilizes).
			// ---------------------------------------------------------------------------

			it('BUG REPRO: records sidecar as authoritative in mtimeCache and clears noSidecarCache', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'config.json', type: 'blob', sha: 'old-sha', size: 50, mode: '100644' },
			]));
			await fs.init();

			const testMtime = 1700000000123;
			const testData = '{"key":"value"}';

			// updateFile (data, identical-ish) → new-data-sha; createFile (sidecar) → new-sidecar-sha
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-data-sha' } }));
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'new-sidecar-sha' } }));

			await fs.writeFileWithMtime('/config.json', testData, testMtime);

			const entry = fs.mtimeCache.get('/config.json');
			expect(entry).toBeDefined();
			// Currently FAILS: writeFileWithMtime never sets fromSidecar:true, so
			// entry is undefined (or fromSidecar:false if a prior stat cached it).
			expect(entry!.fromSidecar).toBe(true);
			expect(entry!.sha).toBe('new-data-sha');
			expect(entry!.lastModified).toBe(new Date(testMtime).toISOString());
			// Negative "no sidecar" cache must be cleared so stat() re-reads the
			// sidecar instead of trusting a stale commit time.
			expect(fs.noSidecarCache.has('/config.json')).toBe(false);
			});

			it('BUG REPRO: post-write stat returns preserved mtime (not commit time) — no NORMALIZE loop', async () => {
			const testMtime = 1700000000123;
			const commitTime = '2025-03-01T00:00:00+08:00';
			const data = '{"key":"value"}';

			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'config.json', type: 'blob', sha: 'S1', size: data.length, mode: '100644' },
			]));
			await fs.init();

			// 1) First stat: sidecar absent on server → getRaw throws → negative
			//    cache set, then Commits API fallback caches commit time as
			//    { fromSidecar: false, sha: 'S1' }.
			fs.api.getRaw = async () => { throw new Error('404 Not Found'); };
			fs.api.getLastCommit = async () => ({ date: commitTime, sha: 'commit-sha' });
			await fs.stat('/config.json');

			// 2) MTIME NORMALIZE case: content is IDENTICAL, only mtime differs.
			//    updateFile returns the SAME blob sha 'S1' (content-addressing),
			//    and the .mtime sidecar carrying testMtime is created.
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'S1' } })); // updateFile (same sha)
			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'SC' } }));  // createFile (sidecar)
			await fs.writeFileWithMtime('/config.json', data, testMtime);

			// 3) Next sync cycle. Data SHA unchanged ('S1') → stat() hits its
			//    cached entry. With the bug: fromSidecar=false + fresh noSidecarCache
			//    → returns the COMMIT time, never the preserved testMtime → loop.
			//    After the fix: returns testMtime and converges.
			const inode = await fs.stat('/config.json');
			expect(inode.mtimeMs).toBe(testMtime); // preserved mtime must win
			});

			it('skips data-file write when content is unchanged (only mtime differs)', async () => {
			const data = '{"key":"value"}';

			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'config.json', type: 'blob', sha: 'S1', size: data.length, mode: '100644' },
			]));
			await fs.init();

			// Simulate the sync engine already having the remote content cached.
			fs.contentCache.set('/config.json', new TextEncoder().encode(data));

			// Record which files actually get written (PUT/POST to Contents API).
			const writtenPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') {
					writtenPaths.push(String(url));
				}
				return Promise.resolve(mockOkJson({ content: { sha: 'SC' } }) as Response);
			});

			// Content identical to the cached remote content, only mtime differs.
			await fs.writeFileWithMtime('/config.json', data, 1700000000999);

			// Data file must NOT be rewritten (no pointless commit), but the
			// .mtime sidecar must still be written with the new mtime.
			// (URLs carry a `?branch=...` query string, so match by substring.)
			const dataWritten = writtenPaths.some((u) => u.includes('config.json') && !u.includes('.mtime'));
			const sidecarWritten = writtenPaths.some((u) => u.includes('config.json.mtime'));
			expect(dataWritten).toBe(false);
			expect(sidecarWritten).toBe(true);
			// Existing data blob SHA is preserved (no rewrite happened).
			expect(fs.shaCache.get('/config.json')).toBe('S1');
			});

			it('still writes data file when content actually changed', async () => {
			const oldData = '{"key":"old"}';
			const newData = '{"key":"new"}';

			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'config.json', type: 'blob', sha: 'S1', size: oldData.length, mode: '100644' },
			]));
			await fs.init();
			// Cached content is the OLD content, but we're writing NEW content.
			fs.contentCache.set('/config.json', new TextEncoder().encode(oldData));

			const writtenPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') {
					writtenPaths.push(String(url));
				}
				return Promise.resolve(mockOkJson({ content: { sha: 'S2' } }) as Response);
			});

			await fs.writeFileWithMtime('/config.json', newData, 1700000000999);

			// Content changed → the data file MUST be rewritten (PUT), and its
			// blob SHA updated. The sidecar is written too.
			const dataWritten = writtenPaths.some((u) => u.includes('config.json') && !u.includes('.mtime'));
			const sidecarWritten = writtenPaths.some((u) => u.includes('config.json.mtime'));
			expect(dataWritten).toBe(true);
			expect(sidecarWritten).toBe(true);
			expect(fs.shaCache.get('/config.json')).toBe('S2');
			});

			it('always creates data file for a brand-new path (no cached SHA)', async () => {
			const data = '{"key":"value"}';

			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();
			// A coincidentally-identical buffer is cached, but the file has no
			// remote SHA yet → it must still be created (POST), never skipped.
			fs.contentCache.set('/config.json', new TextEncoder().encode(data));

			const writtenPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') {
					writtenPaths.push(String(url));
				}
				return Promise.resolve(mockOkJson({ content: { sha: 'NEW' } }) as Response);
			});

			await fs.writeFileWithMtime('/config.json', data, 1700000000999);

			const dataWritten = writtenPaths.some((u) => u.includes('config.json') && !u.includes('.mtime'));
			expect(dataWritten).toBe(true);
			expect(fs.shaCache.get('/config.json')).toBe('NEW');
			});
			});

	describe('createSnapshot', () => {
		it('builds snapshot from Git tree API excluding sidecar files', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'config.json', type: 'blob', sha: 'sha-aaa', size: 100, mode: '100644' },
				{ path: 'notes.md', type: 'blob', sha: 'sha-bbb', size: 50, mode: '100644' },
				{ path: 'config.json.mtime', type: 'blob', sha: 'sha-sidecar', size: 13, mode: '100644' },
				{ path: 'src', type: 'tree', sha: 'tree-sha', mode: '040000' },
				{ path: 'src/index.ts', type: 'blob', sha: 'sha-ccc', size: 200, mode: '100644' },
			]));

			// createSnapshot fetches tree independently
			const snapshot = await fs.createSnapshot('/', undefined);

			expect(snapshot).not.toBeNull();
			expect(snapshot!.size).toBe(3); // config.json, notes.md, src/index.ts (no sidecar, no dir)
			expect(snapshot!.has('config.json')).toBe(true);
			expect(snapshot!.has('notes.md')).toBe(true);
			expect(snapshot!.has('src/index.ts')).toBe(true);
			expect(snapshot!.has('config.json.mtime')).toBe(false);

			// Each entry should have shaHash as mtimeMs proxy
			const entry = snapshot!.get('config.json')!;
			expect(entry.size).toBe(100);
			expect(entry.mtimeMs).toBeGreaterThan(0);
		});

		it('returns null when API is unreachable', async () => {
			fetchSpy.mockRejectedValueOnce(new Error('Network error'));

			const snapshot = await fs.createSnapshot('/', undefined);
			expect(snapshot).toBeNull();
		});

		it('different content produces different mtimeMs proxy', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'a.json', type: 'blob', sha: 'sha-aaa', size: 10, mode: '100644' },
				{ path: 'b.json', type: 'blob', sha: 'sha-bbb', size: 10, mode: '100644' },
			]));

			const snapshot = await fs.createSnapshot('/', undefined);
			expect(snapshot).not.toBeNull();

			const mtimeA = snapshot!.get('a.json')!.mtimeMs;
			const mtimeB = snapshot!.get('b.json')!.mtimeMs;
			expect(mtimeA).not.toBe(mtimeB); // Different SHA → different hash
		});

		it('filters by root path', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'docs/a.md', type: 'blob', sha: 'sha-1', size: 10, mode: '100644' },
				{ path: 'docs/b.md', type: 'blob', sha: 'sha-2', size: 10, mode: '100644' },
				{ path: 'config.json', type: 'blob', sha: 'sha-3', size: 10, mode: '100644' },
			]));

			const snapshot = await fs.createSnapshot('/docs', undefined);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.size).toBe(2);
			expect(snapshot!.has('a.md')).toBe(true);
			expect(snapshot!.has('b.md')).toBe(true);
			expect(snapshot!.has('config.json')).toBe(false);
			});

			it('excludes nested (.mtime.mtime) and dotfile-data (.group-type.mtime) sidecars', async () => {
				// Real leakage shapes observed in logs: nested sidecars and sidecars
				// for dotfile data files must never surface as user-visible entries.
				fetchSpy.mockResolvedValueOnce(mockTreeResponse([
					{ path: 'config.json', type: 'blob', sha: 'sha-aaa', size: 100, mode: '100644' },
					{ path: 'config.json.mtime', type: 'blob', sha: 'sha-s1', size: 13, mode: '100644' },
					{ path: 'config.json.mtime.mtime', type: 'blob', sha: 'sha-s2', size: 13, mode: '100644' },
					{ path: '.group-type.mtime', type: 'blob', sha: 'sha-s3', size: 13, mode: '100644' },
					{ path: '.group-type.mtime.mtime', type: 'blob', sha: 'sha-s4', size: 13, mode: '100644' },
				]));

				const snapshot = await fs.createSnapshot('/', undefined);
				expect(snapshot).not.toBeNull();
				expect(snapshot!.size).toBe(1); // only config.json; sidecars excluded
				expect(snapshot!.has('config.json')).toBe(true);
				expect(snapshot!.has('config.json.mtime')).toBe(false);
				expect(snapshot!.has('config.json.mtime.mtime')).toBe(false);
				expect(snapshot!.has('.group-type.mtime')).toBe(false);
				expect(snapshot!.has('.group-type.mtime.mtime')).toBe(false);
			});

			it('excludes internal .keep placeholder from snapshot', async () => {
				fetchSpy.mockResolvedValueOnce(mockTreeResponse([
					{ path: 'config.json', type: 'blob', sha: 'sha-aaa', size: 100, mode: '100644' },
					{ path: 'sub/.keep', type: 'blob', sha: 'keep-sha', size: 1, mode: '100644' },
				]));

				const snapshot = await fs.createSnapshot('/', undefined);
				expect(snapshot).not.toBeNull();
				expect(snapshot!.has('config.json')).toBe(true);
				// The internal placeholder must never surface as a user-visible entry.
				expect(snapshot!.has('sub/.keep')).toBe(false);
			});
		});

	describe('writeFileWithMtime never nests mtime sidecars', () => {
		it('does NOT create a nested .mtime.mtime when given a sidecar path', async () => {
			const createdPaths: string[] = [];
			fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
				if (init?.method === 'PUT' || init?.method === 'POST') {
					createdPaths.push(String(url));
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					headers: new Headers({ 'content-type': 'application/json' }),
					json: async () => ({ content: { sha: 'new-sha' } }),
					text: async () => '',
					arrayBuffer: async () => new ArrayBuffer(0),
				} as Response);
			});

			// Writing a `.mtime` sidecar as if it were a regular file must not
			// produce a nested `.mtime.mtime` (the bug that generated the
			// historical `.group-type.mtime.mtime` files).
			await fs.writeFileWithMtime('/.group-type.mtime', '{"mtime":123}', 1700000000123);

			expect(createdPaths.some((u) => u.includes('.mtime.mtime'))).toBe(false);
			// The data file itself is still written.
			expect(createdPaths.some((u) => u.includes('.group-type.mtime'))).toBe(true);
		});
	});

	describe('mkdir / rmdir — empty directory .keep placeholder', () => {
		it('mkdir creates an internal .keep placeholder', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([]));
			await fs.init();

			fetchSpy.mockResolvedValueOnce(mockOkJson({ content: { sha: 'keep-sha' } }));
			await fs.mkdir('/newdir');

			// The placeholder must be written internally so the empty directory
			// survives in Git. It is hidden from readdir(), but present in the index.
			expect(
				fs.contentCache.has('/newdir/.keep') || fs.index.has('/newdir/.keep'),
			).toBe(true);
		});

		it('rmdir removes the internal .keep before deleting the directory', async () => {
			fetchSpy.mockResolvedValueOnce(mockTreeResponse([
				{ path: 'newdir', type: 'tree', sha: 'tree-sha', mode: '040000' },
				{ path: 'newdir/.keep', type: 'blob', sha: 'keep-sha', size: 1, mode: '100644' },
			]));
			await fs.init();

			fetchSpy.mockResolvedValue(mockOkJson({ commit: { sha: 'c' } }));
			await fs.rmdir('/newdir');

			expect(fs.shaCache.has('/newdir/.keep')).toBe(false);
			expect(fs.index.has('/newdir')).toBe(false);
		});
	});
});
