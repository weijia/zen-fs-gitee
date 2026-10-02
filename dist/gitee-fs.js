import { withErrno } from 'kerium';
import { IndexFS, Index, Inode } from '@zenfs/core';
import { S_IFDIR, S_IFREG } from '@zenfs/core/constants';
import { IdbKVStore } from 'zen-fs-cache';
import { GiteeAPI } from './gitee-api.js';
import { createLogger } from '@richard432/localstorage-logger';
const log = createLogger('GiteeFS');
/**
 * Verbose writeFileWithMtime diagnostic. Hidden by default — enable with:
 *   localStorage.setItem('debug:verbose:GiteeFS', '1')
 */
const GITEEFS_VERBOSE_KEY = 'debug:verbose:GiteeFS';
try {
    if (localStorage.getItem(GITEEFS_VERBOSE_KEY) === null)
        localStorage.setItem(GITEEFS_VERBOSE_KEY, '0');
}
catch {
    /* localStorage unavailable (Node.js) — stays hidden */
}
function diagLog(...args) {
    try {
        if (localStorage.getItem(GITEEFS_VERBOSE_KEY) === '1')
            console.log('[GiteeFS:diag]', ...args);
    }
    catch {
        /* ignore */
    }
}
import { mtimePathFor, sidecarToDataPath, shaHash } from './utils.js';
/** TTL (ms) for the negative cache of "path has no .mtime sidecar" — avoids 404 storms. */
const NO_SIDECAR_TTL_MS = 10 * 60 * 1000;
/**
 * A ZenFS backend for Gitee repositories.
 *
 * Implements the `FileSystem` interface by mapping file operations
 * to the Gitee REST API v5.
 */
export class GiteeFS extends IndexFS {
    api;
    /**
     * Human-readable backend identifier used by zen-fs-sync diagnostics
     * (e.g. naming the backend that leaked a mtime sidecar in a warning).
     */
    backendName;
    /** Maps file paths to their blob SHA (needed for updates/deletes). */
    shaCache = new Map();
    /** In-memory content cache to support synchronous reads. */
    contentCache = new Map();
    /** Cached file mtime entries: path -> { sha, lastModified, fromSidecar }. */
    mtimeCache = new Map();
    /** Paths confirmed (via 404) to have NO .mtime sidecar; value = timestamp. Avoids repeated 404s. */
    noSidecarCache = new Map();
    /** Serializes async background operations. */
    pending = Promise.resolve();
    options;
    initialized = false;
    /** Last known commit SHA of the configured branch (baseline for shouldSync). */
    lastCommitSha = null;
    // --- IndexedDB persistence for internal caches ---
    /** Persists shaCache (path → blob SHA) across page reloads. */
    shaStore;
    /** Persists contentCache (path → file content) across page reloads. */
    contentStore;
    /** Persists mtimeCache (path → { sha, lastModified }) across page reloads. */
    mtimeStore;
    /** Persists lastCommitSha across page reloads for shouldSync baseline. */
    commitShaStore;
    constructor(options) {
        super(0x6769746565, 'gitee', new Index());
        this.options = options;
        this.api = new GiteeAPI(options);
        // Set backend name so zen-fs-sync warnings can name the owner/repo that produced a path.
        this.backendName = `Gitee@${options.owner}/${options.repo}`;
        // Each repo gets its own set of IndexedDB databases, namespaced by owner/repo.
        const dbBase = `zen-fs-gitee:${options.owner}/${options.repo}`;
        this.shaStore = new IdbKVStore(`${dbBase}:sha`, 'cache');
        this.contentStore = new IdbKVStore(`${dbBase}:content`, 'cache');
        this.mtimeStore = new IdbKVStore(`${dbBase}:mtime`, 'cache');
        this.commitShaStore = new IdbKVStore(`${dbBase}:commit-sha`, 'cache');
    }
    /**
     * Queue an async operation to run after all previous ones finish.
     * Used by sync methods to trigger background writes/deletes.
     */
    _queue(p) {
        this.pending = this.pending.then(() => p).catch(() => { });
    }
    // --- IndexedDB persistence helpers ---
    /** Persist a single shaCache entry to IndexedDB (fire-and-forget). */
    _persistSha(path, sha) {
        this.shaStore.set(path, sha).catch(() => { });
    }
    /** Persist a single contentCache entry to IndexedDB (fire-and-forget). */
    _persistContent(path, data) {
        this.contentStore.set(path, data).catch(() => { });
    }
    /** Persist a single mtimeCache entry to IndexedDB (fire-and-forget). */
    _persistMtime(path, entry) {
        this.mtimeStore.set(path, entry).catch(() => { });
    }
    /** Delete a shaCache entry from IndexedDB (fire-and-forget). */
    _deleteSha(path) {
        this.shaStore.delete(path).catch(() => { });
    }
    /** Delete a contentCache entry from IndexedDB (fire-and-forget). */
    _deleteContent(path) {
        this.contentStore.delete(path).catch(() => { });
    }
    /** Delete a mtimeCache entry from IndexedDB (fire-and-forget). */
    _deleteMtime(path) {
        this.mtimeStore.delete(path).catch(() => { });
    }
    /**
     * Load all persistent caches from IndexedDB into the in-memory Maps.
     * Called at the start of `init()` to enable a warm start — file contents
     * and SHAs from the previous session are immediately available for sync
     * reads, avoiding redundant API calls for unchanged files.
     */
    async loadFromIDB() {
        const [shaEntries, contentEntries, mtimeEntries, savedCommitSha] = await Promise.all([
            this.shaStore.entries(),
            this.contentStore.entries(),
            this.mtimeStore.entries(),
            this.commitShaStore.get('lastCommitSha'),
        ]);
        for (const [path, sha] of shaEntries) {
            this.shaCache.set(path, sha);
        }
        for (const [path, data] of contentEntries) {
            this.contentCache.set(path, data);
        }
        for (const [path, entry] of mtimeEntries) {
            // Old cached entries may lack fromSidecar; default to false so a real
            // sidecar is re-detected on the next stat() instead of being trusted
            // as a stale commit-time mtime forever.
            this.mtimeCache.set(path, {
                sha: entry.sha,
                lastModified: entry.lastModified,
                fromSidecar: entry.fromSidecar ?? false,
            });
        }
        this.lastCommitSha = savedCommitSha ?? null;
        log.log(`IDB restore: ${shaEntries.length} SHAs, ${contentEntries.length} contents, ${mtimeEntries.length} mtime entries, commitSha=${this.lastCommitSha?.slice(0, 7) ?? 'none'}`);
    }
    /**
     * Initialize the file system by loading the repository tree.
     * If the configured branch does not exist, it will be created from 'master'.
     *
     * Warm start: persistent caches (shaCache, contentCache, mtimeCache) are
     * loaded from IndexedDB first, so file contents from the previous session
     * are immediately available. The tree API then provides fresh SHAs —
     * files whose SHA hasn't changed keep their cached content (zero
     * re-fetching), while changed files are invalidated for on-demand re-read.
     */
    async init() {
        if (this.initialized)
            return;
        // 1. Warm start: load persistent caches from IndexedDB
        await this.loadFromIDB();
        // 2. Fetch fresh tree from API
        let tree = [];
        try {
            tree = await this.api.getTree(true);
        }
        catch (err) {
            const msg = err.message || '';
            // Branch not found — try to create it
            if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
                log.log(`Branch '${this.options.branch}' not found, attempting to create...`);
                await this.api.createBranch(this.options.branch || 'master', 'master');
                // Retry loading tree
                tree = await this.api.getTree(true);
            }
            else {
                throw err;
            }
        }
        // 3. Build index from fresh tree, reusing cached content where SHA is unchanged
        const freshPaths = new Set();
        const shaUpdates = [];
        for (const item of tree) {
            const path = '/' + item.path;
            const isDir = item.type === 'tree';
            freshPaths.add(path);
            // Skip mtime sidecar files — they are internal metadata, not user files.
            // But cache their SHA so we can delete them atomically later.
            // Use sidecarToDataPath (not isMtimeSidecar) so directory-prefixed
            // paths like `documents/.note.json.mtime` are detected correctly.
            if (!isDir && sidecarToDataPath(item.path)) {
                const oldSha = this.shaCache.get(path);
                this.shaCache.set(path, item.sha);
                if (oldSha !== item.sha)
                    shaUpdates.push([path, item.sha]);
                continue;
            }
            const id = this.index._alloc();
            const inode = new Inode({
                ino: id,
                data: id + 1,
                mode: isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644,
                size: item.size || 0,
                uid: 0,
                gid: 0,
                nlink: 1,
                atimeMs: Date.now(),
                mtimeMs: Date.now(),
                ctimeMs: Date.now(),
                birthtimeMs: Date.now(),
            });
            this.index.set(path, inode);
            if (!isDir) {
                const oldSha = this.shaCache.get(path);
                this.shaCache.set(path, item.sha);
                shaUpdates.push([path, item.sha]);
                // If SHA changed, invalidate cached content (will be re-fetched on demand)
                if (oldSha && oldSha !== item.sha) {
                    this.contentCache.delete(path);
                    this._deleteContent(path);
                    // mtimeCache is also invalid — SHA changed
                    this.mtimeCache.delete(path);
                    this._deleteMtime(path);
                }
            }
        }
        // 4. Remove stale entries (files deleted from remote since last session)
        const stalePaths = [];
        for (const [path] of this.shaCache) {
            if (!freshPaths.has(path)) {
                stalePaths.push(path);
            }
        }
        for (const path of stalePaths) {
            this.shaCache.delete(path);
            this.contentCache.delete(path);
            this.mtimeCache.delete(path);
            this._deleteSha(path);
            this._deleteContent(path);
            this._deleteMtime(path);
        }
        // 5. Bulk-persist updated SHAs to IndexedDB
        if (shaUpdates.length > 0) {
            this.shaStore.setMany(shaUpdates).catch(() => { });
        }
        // Ensure root directory exists
        if (!this.index.has('/')) {
            const id = this.index._alloc();
            this.index.set('/', new Inode({
                ino: id,
                data: id + 1,
                mode: S_IFDIR | 0o755,
                size: 0,
                uid: 0,
                gid: 0,
                nlink: 1,
                atimeMs: Date.now(),
                mtimeMs: Date.now(),
                ctimeMs: Date.now(),
                birthtimeMs: Date.now(),
            }));
        }
        // 6. Record current commit SHA as shouldSync baseline
        //    On first init (no prior baseline), set it so shouldSync doesn't
        //    force an unnecessary full sync on the very first poll.
        if (!this.lastCommitSha) {
            try {
                this.lastCommitSha = await this.api.getLatestCommitSha();
                if (this.lastCommitSha) {
                    this.commitShaStore.set('lastCommitSha', this.lastCommitSha).catch(() => { });
                }
            }
            catch { /* non-fatal — shouldSync will return true */ }
        }
        this.initialized = true;
    }
    /**
     * Preload all file contents into memory cache.
     * This enables synchronous reads.
     *
     * Uses bounded concurrency (default 8) to parallelize API calls.
     * Skips tombstone files (.meta/.deleted/) and version sidecar files
     * (.version) since they are metadata, not user content.
     *
     * Files already in contentCache (restored from IndexedDB during init)
     * are skipped — they don't need re-fetching from the API.
     */
    async preloadContents() {
        const CONCURRENCY = 8;
        // Collect all paths that need preloading
        const pathsToPreload = [];
        // Regular files from the index
        for (const [path, node] of this.index) {
            if ((node.mode & S_IFREG) !== S_IFREG)
                continue;
            if (this.contentCache.has(path))
                continue; // already cached (from IDB or previous read)
            // Skip tombstone files and version sidecars — they are metadata,
            // not user content, and are read on demand by the sync engine.
            if (path.includes('/.meta/.deleted/'))
                continue;
            if (path.endsWith('.version'))
                continue;
            pathsToPreload.push(path);
        }
        // Mtime sidecar files (not in index but in shaCache)
        for (const [path] of this.shaCache) {
            // sidecarToDataPath reliably detects every `<name>.mtime` sidecar
            // (including those whose data path is directory-prefixed) and maps
            // them back to the data file, so non-sidecar paths are skipped.
            if (!sidecarToDataPath(path))
                continue;
            if (this.contentCache.has(path))
                continue;
            if (path.includes('/.meta/.deleted/'))
                continue;
            pathsToPreload.push(path);
        }
        // Fetch in parallel with bounded concurrency
        let index = 0;
        const fetchOne = async () => {
            while (index < pathsToPreload.length) {
                const path = pathsToPreload[index++];
                try {
                    const data = new Uint8Array(await this.api.getRaw(path));
                    this.contentCache.set(path, data);
                    // Persist newly fetched content to IndexedDB
                    this._persistContent(path, data);
                }
                catch {
                    // Ignore preload errors for individual files
                }
            }
        };
        const workers = Array.from({ length: Math.min(CONCURRENCY, pathsToPreload.length) }, () => fetchOne());
        await Promise.all(workers);
    }
    async ready() {
        if (!this.initialized) {
            await this.init();
            if (!this.options.disableAsyncCache) {
                await this.preloadContents();
            }
        }
    }
    readySync() {
        if (!this.initialized) {
            throw withErrno('EAGAIN', 'GiteeFS is not initialized');
        }
    }
    // --- Remove ---
    async remove(path) {
        const sidecarPath = mtimePathFor(path);
        const dataSha = this.shaCache.get(path);
        const sidecarSha = this.shaCache.get(sidecarPath);
        // Delete data file and sidecar separately via Contents API.
        // Gitee only supports the Contents API for file deletion
        // (DELETE /repos/{owner}/{repo}/contents/{path}).
        if (dataSha) {
            await this.api.deleteFile(path, dataSha, `Delete ${path}`);
            this.shaCache.delete(path);
            this._deleteSha(path);
        }
        if (sidecarSha) {
            await this.api.deleteFile(sidecarPath, sidecarSha, `Delete sidecar ${sidecarPath}`);
            this.shaCache.delete(sidecarPath);
            this._deleteSha(sidecarPath);
        }
        this.contentCache.delete(path);
        this.contentCache.delete(sidecarPath);
        this._deleteContent(path);
        this._deleteContent(sidecarPath);
        this.mtimeCache.delete(path);
        this._deleteMtime(path);
        // Remove from the in-memory Index so stat()/exists() correctly
        // report the file as deleted. Without this, the Index retains a
        // stale entry and stat() keeps returning the old inode, causing
        // tombstone processors and sync engines to think the file still
        // exists and repeatedly attempt deletion.
        this.index.delete(path);
    }
    removeSync(path) {
        const sidecarPath = mtimePathFor(path);
        const dataSha = this.shaCache.get(path);
        const sidecarSha = this.shaCache.get(sidecarPath);
        // Delete data file and sidecar separately via Contents API.
        // See remove() for explanation.
        if (dataSha) {
            this._queue(this.api.deleteFile(path, dataSha, `Delete ${path}`)
                .then(() => { this.shaCache.delete(path); this._deleteSha(path); })
                .catch(() => { }));
        }
        if (sidecarSha) {
            this._queue(this.api.deleteFile(sidecarPath, sidecarSha, `Delete sidecar ${sidecarPath}`)
                .then(() => { this.shaCache.delete(sidecarPath); this._deleteSha(sidecarPath); })
                .catch(() => { }));
        }
        this.contentCache.delete(path);
        this.contentCache.delete(sidecarPath);
        this._deleteContent(path);
        this._deleteContent(sidecarPath);
        this.mtimeCache.delete(path);
        this._deleteMtime(path);
        // Remove from the in-memory Index — see remove() for explanation.
        this.index.delete(path);
    }
    // --- Read ---
    async read(path, buffer, start, end) {
        if (end - start <= 0)
            return;
        let data = this.contentCache.get(path);
        if (!data) {
            data = new Uint8Array(await this.api.getRaw(path));
            this.contentCache.set(path, data);
            // Persist newly fetched content to IndexedDB
            this._persistContent(path, data);
        }
        const length = Math.min(end - start, data.length - start, buffer.length);
        if (length > 0) {
            buffer.set(data.subarray(start, start + length));
        }
    }
    readSync(path, buffer, start, end) {
        if (end - start <= 0)
            return;
        const data = this.contentCache.get(path);
        if (!data) {
            this._queue(this.read(path, new Uint8Array(0), 0, 0).catch(() => { }));
            throw withErrno('EAGAIN', 'File content not cached, use async read instead');
        }
        const length = Math.min(end - start, data.length - start, buffer.length);
        if (length > 0) {
            buffer.set(data.subarray(start, start + length));
        }
    }
    // --- Write ---
    async write(path, data, offset, mtimeMs) {
        let existing = this.contentCache.get(path) || new Uint8Array(0);
        const newSize = Math.max(existing.length, offset + data.length);
        const merged = new Uint8Array(newSize);
        merged.set(existing);
        merged.set(data, offset);
        // Gitee can't store 0-byte files — use \n as placeholder
        const writeContent = merged.length === 0
            ? new TextEncoder().encode('\n')
            : merged;
        this.contentCache.set(path, writeContent);
        this._persistContent(path, writeContent);
        // Preserve the source's real mtime (fall back to now). Without this the
        // target mtime would be lost and stat() would fall back to the commit
        // time, making the sync engine re-PUT content-identical files every
        // cycle (see DESIGN.md §4).
        const effectiveMtime = mtimeMs ?? Date.now();
        const inode = this.index.get(path);
        if (inode) {
            inode.update({ mtimeMs: effectiveMtime, size: writeContent.length });
        }
        const sha = this.shaCache.get(path);
        if (sha) {
            const newSha = await this.api.updateFile(path, writeContent, sha, `Update ${path}`);
            this.shaCache.set(path, newSha);
            this._persistSha(path, newSha);
        }
        else {
            const newSha = await this.api.createFile(path, writeContent, `Create ${path}`);
            this.shaCache.set(path, newSha);
            this._persistSha(path, newSha);
        }
        // Write the .mtime sidecar so cross-backend sync can compare the real
        // modification time instead of the Gitee commit time.
        await this.writeMtimeSidecar(path, effectiveMtime);
    }
    writeSync(path, data, offset, mtimeMs) {
        let existing = this.contentCache.get(path) || new Uint8Array(0);
        const newSize = Math.max(existing.length, offset + data.length);
        const merged = new Uint8Array(newSize);
        merged.set(existing);
        merged.set(data, offset);
        // Gitee can't store 0-byte files — use \n as placeholder
        const writeContent = merged.length === 0
            ? new TextEncoder().encode('\n')
            : merged;
        this.contentCache.set(path, writeContent);
        this._persistContent(path, writeContent);
        // Preserve the source's real mtime (fall back to now). See DESIGN.md §4.
        const effectiveMtime = mtimeMs ?? Date.now();
        const inode = this.index.get(path);
        if (inode) {
            inode.update({ mtimeMs: effectiveMtime, size: writeContent.length });
        }
        const sha = this.shaCache.get(path);
        this._queue((sha
            ? this.api.updateFile(path, writeContent, sha, `Update ${path}`)
            : this.api.createFile(path, writeContent, `Create ${path}`))
            .then((newSha) => {
            this.shaCache.set(path, newSha);
            this._persistSha(path, newSha);
        })
            .catch(() => { }));
        // Write the .mtime sidecar (queued, fire-and-forget) — see DESIGN.md §4.
        this.writeMtimeSidecarSync(path, effectiveMtime);
    }
    // --- Mtime sidecar helpers (mirrors RemoteStorageFileSystem.writeFile) ---
    /** Write/update the `.mtime` sidecar for a file (async). */
    async writeMtimeSidecar(path, mtimeMs) {
        // Never nest sidecars: if `path` is itself a .mtime sidecar, do nothing
        // (otherwise we'd create `.file.mtime.mtime`). This happens when a sidecar
        // file is legitimately synced as a regular file to another backend.
        if (sidecarToDataPath(path) !== null) {
            // Path is already a `.mtime` sidecar — never nest it into
            // `.mtime.mtime`. Warn so the caller (a sync engine replicating a
            // sidecar as a regular file) can be identified and fixed.
            log.warn(`refusing to write nested mtime sidecar for ${path} (already a .mtime sidecar) — would create .mtime.mtime`);
            return;
        }
        const sidecarPath = mtimePathFor(path);
        const sidecarContent = new TextEncoder().encode(String(mtimeMs));
        const existingSidecarSha = this.shaCache.get(sidecarPath);
        const newSha = existingSidecarSha
            ? await this.api.updateFile(sidecarPath, sidecarContent, existingSidecarSha, `Update sidecar for ${path}`)
            : await this.api.createFile(sidecarPath, sidecarContent, `Create sidecar for ${path}`);
        this.shaCache.set(sidecarPath, newSha);
        this._persistSha(sidecarPath, newSha);
        this.contentCache.set(sidecarPath, sidecarContent);
        this._persistContent(sidecarPath, sidecarContent);
        // Refresh the *data file's* mtime cache so the next stat() immediately
        // sees the real mtime instead of an ever-changing commit time (which
        // re-triggers MTIME NORMALIZE). writeMtimeSidecar() bypasses the index,
        // so the local caches must be refreshed here.
        this.noSidecarCache.delete(path);
        const dataSha = this.shaCache.get(path);
        if (dataSha) {
            const entry = { sha: dataSha, lastModified: new Date(mtimeMs).toISOString(), fromSidecar: true };
            this.mtimeCache.set(path, entry);
            this._persistMtime(path, entry);
        }
    }
    /** Write/update the `.mtime` sidecar for a file (sync, queued). */
    writeMtimeSidecarSync(path, mtimeMs) {
        // Never nest sidecars — see writeMtimeSidecar().
        if (sidecarToDataPath(path) !== null) {
            // Path is already a `.mtime` sidecar — never nest it into
            // `.mtime.mtime`. Warn so the caller (a sync engine replicating a
            // sidecar as a regular file) can be identified and fixed.
            log.warn(`refusing to write nested mtime sidecar for ${path} (already a .mtime sidecar) — would create .mtime.mtime`);
            return;
        }
        const sidecarPath = mtimePathFor(path);
        const sidecarContent = new TextEncoder().encode(String(mtimeMs));
        const existingSidecarSha = this.shaCache.get(sidecarPath);
        this._queue((existingSidecarSha
            ? this.api.updateFile(sidecarPath, sidecarContent, existingSidecarSha, `Update sidecar for ${path}`)
            : this.api.createFile(sidecarPath, sidecarContent, `Create sidecar for ${path}`))
            .then((newSha) => {
            this.shaCache.set(sidecarPath, newSha);
            this._persistSha(sidecarPath, newSha);
        })
            .catch(() => { }));
        this.contentCache.set(sidecarPath, sidecarContent);
        this._persistContent(sidecarPath, sidecarContent);
        // Refresh the *data file's* mtime cache so the next stat() immediately
        // sees the real mtime (see writeMtimeSidecar()). Done synchronously here
        // (not inside the queued promise) so it takes effect without waiting for
        // the sidecar write to flush.
        this.noSidecarCache.delete(path);
        const dataSha = this.shaCache.get(path);
        if (dataSha) {
            const entry = { sha: dataSha, lastModified: new Date(mtimeMs).toISOString(), fromSidecar: true };
            this.mtimeCache.set(path, entry);
            this._persistMtime(path, entry);
        }
    }
    // --- WriteFile override (forward { mtime } into the sidecar) ---
    /**
     * Override base `writeFile` so an optional `{ mtime }` option is forwarded
     * to `write()` and persisted in the `.mtime` sidecar. This is what makes
     * cross-backend mtime preservation actually take effect when the sync
     * engine writes through `writeFile({ mtime })` (e.g. via CachedFileSystem
     * + adapter), not only through `writeFileWithMtime`.
     */
    async writeFile(path, data, options) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await this.write(path, buf, 0, options?.mtime);
    }
    writeFileSync(path, data, options) {
        const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        this.writeSync(path, buf, 0, options?.mtime);
    }
    // --- Sync ---
    async sync() {
        await this.pending;
    }
    syncSync() {
        // Background ops are fire-and-forget; nothing to do synchronously
    }
    // --- Stat (overridden to provide real mtime from sidecar or Commits API) ---
    /**
     * Get the stat of a file. For regular files, this enriches the Inode's
     * mtimeMs with the real modification time.
     *
     * Priority:
     * 1. Cached mtime (mtimeCache) — if SHA hasn't changed, return cached value
     * 2. mtime sidecar file (most precise — stores millisecond mtime)
     * 3. Commits API (second-level precision, fallback for files without sidecar)
     * 4. Inode's default mtimeMs (set during init or write)
     *
     * The sidecar is only checked when the blob SHA has changed (i.e., file
     * content changed) or there is no cached mtime. This avoids repeated API
     * calls for unchanged files.
     */
    async stat(path) {
        const inode = await super.stat(path);
        // Only enrich mtime for regular files
        if ((inode.mode & S_IFREG) !== S_IFREG)
            return inode;
        const currentSha = this.shaCache.get(path);
        const cached = this.mtimeCache.get(path);
        // 1. Cached mtime. Trust it ONLY when it came from the .mtime sidecar
        //    (exact, stable), or when we have *also* confirmed (via 404) that no
        //    sidecar exists for this path within the negative-cache window.
        //    A cached commit-time value without that confirmation is NOT trusted:
        //    writeFileWithMtime() writes the sidecar via the raw API and bypasses
        //    the local index, so the sidecar may exist on the server even though
        //    this stat() can't see it. Trusting a stale commit time here is what
        //    caused the endless MTIME NORMALIZE loop (target mtime changed every
        //    sync → source/target never agreed → re-PUT the same content).
        if (cached && cached.sha === currentSha) {
            const neg2 = this.noSidecarCache.get(path);
            const negFresh = neg2 !== undefined && Date.now() - neg2 <= NO_SIDECAR_TTL_MS;
            console.log('[DIAG-GITEE] stat step1', path, 'fromSidecar=', cached.fromSidecar, 'noSidecarFresh=', negFresh, 'cachedMtime=', cached.lastModified);
            if (cached.fromSidecar) {
                inode.update({ mtimeMs: new Date(cached.lastModified).getTime() });
                return inode;
            }
            const neg = this.noSidecarCache.get(path);
            if (neg !== undefined && Date.now() - neg <= NO_SIDECAR_TTL_MS) {
                inode.update({ mtimeMs: new Date(cached.lastModified).getTime() });
                return inode;
            }
            // fromSidecar=false and no fresh negative entry → fall through to
            // re-check the sidecar (it may have been written in the meantime).
        }
        const sidecarPath = mtimePathFor(path);
        // 2. Try the .mtime sidecar first (authoritative, preserves the source's
        //    real modification time). Do NOT gate on shaCache.has(sidecarPath):
        //    writeFileWithMtime() bypasses the local index, so the sidecar SHA is
        //    often unknown locally even though the file exists on the server.
        //    Always attempt to read it; a confirmed-missing sidecar (404) is
        //    remembered in noSidecarCache to avoid a 404 storm, but with a short
        //    TTL so a sidecar written later is still picked up.
        const neg = this.noSidecarCache.get(path);
        if (neg === undefined || Date.now() - neg > NO_SIDECAR_TTL_MS) {
            try {
                const sidecarData = this.contentCache.get(sidecarPath)
                    || (await this.api.getRaw(sidecarPath));
                const sidecarBytes = sidecarData instanceof Uint8Array
                    ? sidecarData
                    : new Uint8Array(sidecarData);
                if (!this.contentCache.has(sidecarPath)) {
                    this.contentCache.set(sidecarPath, sidecarBytes);
                    this._persistContent(sidecarPath, sidecarBytes);
                }
                const mtimeStr = new TextDecoder().decode(sidecarBytes).trim();
                const mtimeMs = Number(mtimeStr);
                if (!isNaN(mtimeMs) && mtimeMs > 0) {
                    inode.update({ mtimeMs });
                    if (currentSha) {
                        const mtimeEntry = { sha: currentSha, lastModified: new Date(mtimeMs).toISOString(), fromSidecar: true };
                        this.mtimeCache.set(path, mtimeEntry);
                        this._persistMtime(path, mtimeEntry);
                    }
                    return inode;
                }
                // Sidecar present but unparsable → fall through to Commits API.
            }
            catch {
                // 404 / network error — no sidecar (yet). Remember it briefly.
                this.noSidecarCache.set(path, Date.now());
            }
        }
        // 3. Fall back to Commits API (imprecise: commit time varies per sync).
        //    Cache it with fromSidecar=false so step 1 won't trust it across
        //    cycles without a confirming negative entry, allowing re-detection
        //    of a sidecar that appears later.
        if (currentSha) {
            const commit = await this.api.getLastCommit(path);
            if (commit) {
                const mtimeEntry = { sha: currentSha, lastModified: commit.date, fromSidecar: false };
                this.mtimeCache.set(path, mtimeEntry);
                this._persistMtime(path, mtimeEntry);
                console.log('[DIAG-GITEE] stat step3 COMMIT-FALLBACK', path, 'commitDate=', commit.date, '=> mtime=', new Date(commit.date).getTime());
                inode.update({ mtimeMs: new Date(commit.date).getTime() });
                return inode;
            }
        }
        return inode;
    }
    // -----------------------------------------------------------------------
    // writeFileWithMtime — write file + mtime sidecar atomically
    // -----------------------------------------------------------------------
    /**
     * Write a file and preserve the specified mtime by writing a sidecar file
     * (`.filename.mtime`) containing the mtimeMs as a string.
     *
     * Uses the Contents API (createFile/updateFile) for both the data file and
     * the sidecar, because Gitee only supports the Contents API for file writes.
     * The Git Data API write endpoints return 404 on Gitee.
     *
     * The API calls are made FIRST, and only after both succeed are the local
     * caches (contentCache, shaCache, inode) updated. This prevents a situation
     * where the cache says the file exists but the remote was never actually
     * written — which would cause the sync engine to make incorrect decisions
     * on the next cycle (e.g., treating a file as "deleted from source" when
     * it was never successfully written).
     *
     * This is called by zen-fs-sync's `copyFile()` to preserve the source
     * file's real mtime across sync, since Git commit time only has second-level
     * precision and doesn't reflect the actual file modification time.
     */
    async writeFileWithMtime(path, data, mtimeMs) {
        // Normalize data to Uint8Array
        let content = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;
        // Gitee can't store 0-byte files — substitute a single `\n`.
        // The contentCache and inode must reflect what's actually on Gitee
        // (1 byte), otherwise snapshot comparisons will always detect a
        // mismatch and trigger endless re-syncs.
        if (content.length === 0) {
            content = new TextEncoder().encode('\n');
        }
        // Build sidecar content (mtimeMs as string)
        const sidecarPath = mtimePathFor(path);
        const sidecarContent = new TextEncoder().encode(String(mtimeMs));
        // 1. Write data file via Contents API
        const existingDataSha = this.shaCache.get(path);
        let newDataSha;
        if (existingDataSha) {
            newDataSha = await this.api.updateFile(path, content, existingDataSha, `Update ${path} (mtime=${mtimeMs})`);
        }
        else {
            newDataSha = await this.api.createFile(path, content, `Create ${path} (mtime=${mtimeMs})`);
        }
        // 3. Only after the data API call succeeds, update local caches
        this.contentCache.set(path, content);
        this._persistContent(path, content);
        this.shaCache.set(path, newDataSha);
        this._persistSha(path, newDataSha);
        // 2. Write sidecar file via Contents API — but never nest: if `path` is
        //    itself a `.mtime` sidecar, skip the sidecar write (otherwise we'd
        //    create `.file.mtime.mtime`). Mirrors the guard in writeMtimeSidecar().
        if (sidecarToDataPath(path) === null) {
            const existingSidecarSha = this.shaCache.get(sidecarPath);
            let newSidecarSha;
            if (existingSidecarSha) {
                newSidecarSha = await this.api.updateFile(sidecarPath, sidecarContent, existingSidecarSha, `Update sidecar for ${path}`);
            }
            else {
                newSidecarSha = await this.api.createFile(sidecarPath, sidecarContent, `Create sidecar for ${path}`);
            }
            this.contentCache.set(sidecarPath, sidecarContent);
            this._persistContent(sidecarPath, sidecarContent);
            this.shaCache.set(sidecarPath, newSidecarSha);
            this._persistSha(sidecarPath, newSidecarSha);
        }
        else {
            log.warn(`writeFileWithMtime: refusing to write nested mtime sidecar for ${path} (already a .mtime sidecar)`);
        }
        // 4. Update inode with the specified mtime
        const inode = this.index.get(path);
        if (inode) {
            inode.update({ mtimeMs, size: content.length });
        }
        // 4b. Refresh the data file's mtime cache so the next stat() immediately
        // sees the real preserved mtime (fromSidecar: true) instead of falling
        // back to the ever-changing commit time (which re-triggers MTIME
        // NORMALIZE). writeFileWithMtime() writes the sidecar via the raw API and
        // bypasses the local index, so the cache must be refreshed here — same
        // as writeMtimeSidecar()/writeMtimeSidecarSync().
        this.noSidecarCache.delete(path);
        const dataSha = this.shaCache.get(path);
        if (dataSha) {
            const entry = { sha: dataSha, lastModified: new Date(mtimeMs).toISOString(), fromSidecar: true };
            this.mtimeCache.set(path, entry);
            this._persistMtime(path, entry);
        }
        diagLog('writeFileWithMtime DONE', path, 'mtimeMs=', mtimeMs, 'mtimeCache.fromSidecar=', this.mtimeCache.get(path)?.fromSidecar, 'noSidecarCache.has=', this.noSidecarCache.has(path));
    }
    // -----------------------------------------------------------------------
    // createSnapshot — efficient snapshot using Git tree API
    // -----------------------------------------------------------------------
    /**
     * Build a file snapshot efficiently using the Git tree API.
     *
     * Instead of walking the filesystem and calling `stat()` for each file
     * (which would trigger N API calls), this method fetches the entire tree
     * in a single API request and builds the snapshot from tree items.
     *
     * mtimeMs is taken from the `.mtime` sidecar when available (the real
     * modification time preserved across sync — see DESIGN.md §4), so the
     * target-side mtime stays comparable with the source's real mtime. When a
     * file has no sidecar (legacy writes), it falls back to `shaHash(blobSha)`
     * as a content-stable proxy — different content produces a different SHA,
     * which the sync engine detects as a change, and which is more reliable
     * than commit timestamps (only second-level precision, shared across files
     * committed together).
     *
     * Sidecar files (`.filename.mtime`) are excluded from the snapshot so they
     * don't appear as user-visible files.
     *
     * If the Gitee API is unreachable, returns `null` to signal that the
     * snapshot could not be built.
     */
    async createSnapshot(root, filter) {
        try {
            const tree = await this.api.getTree(true);
            const snapshot = new Map();
            // First pass: index mtime sidecars (data path → sidecar path).
            // sidecarToDataPath() returns non-null only for `.filename.mtime`
            // files, so it doubles as a reliable sidecar detector (unlike
            // isMtimeSidecar(item.path), which fails on directory-prefixed paths).
            const sidecarByData = new Map();
            for (const item of tree) {
                if (item.type === 'tree')
                    continue;
                const dataPath = sidecarToDataPath(item.path);
                if (dataPath)
                    sidecarByData.set('/' + dataPath, '/' + item.path);
            }
            // Second pass: build snapshot for real data files.
            for (const item of tree) {
                // Skip directories
                if (item.type === 'tree')
                    continue;
                // Skip mtime sidecar files (internal metadata) — also excludes
                // them from appearing as user-visible files.
                if (sidecarToDataPath(item.path)) {
                    // A nested sidecar (`*.mtime.mtime`) is a pathological artifact
                    // that must never be synced; warn so it can be cleaned up.
                    if (item.path.endsWith('.mtime.mtime')) {
                        log.warn(`createSnapshot: skipping nested mtime sidecar (won't sync): /${item.path}`);
                    }
                    continue;
                }
                const fullPath = '/' + item.path;
                // Apply root filter: only include files under the specified root
                const normalizedRoot = root === '/' ? '' : root;
                if (normalizedRoot && !fullPath.startsWith(normalizedRoot + '/')) {
                    continue;
                }
                // Compute relative path from root
                const relPath = normalizedRoot
                    ? fullPath.slice(normalizedRoot.length + 1)
                    : fullPath.slice(1);
                // Apply include/exclude prefix filters
                if (filter) {
                    if (filter.excludePrefixes?.some(p => relPath.startsWith(p)))
                        continue;
                    if (filter.includePrefixes && filter.includePrefixes.length > 0) {
                        if (!filter.includePrefixes.some(p => relPath.startsWith(p)))
                            continue;
                    }
                }
                // Default mtime proxy (used only when no real-mtime sidecar is
                // available). shaHash(blobSha) is stable per content and avoids
                // the second-level precision issues of commit timestamps.
                const mtimeMsProxy = shaHash(item.sha);
                // Prefer the real mtime preserved in the `.mtime` sidecar. This
                // keeps target-side mtime comparable with the source's real
                // modification time (see DESIGN.md §4) instead of a content hash.
                let mtimeMs = mtimeMsProxy;
                const sidecarPath = sidecarByData.get(fullPath);
                if (sidecarPath) {
                    const cached = this.contentCache.get(sidecarPath);
                    if (cached) {
                        const mtimeStr = new TextDecoder().decode(cached).trim();
                        const parsed = Number(mtimeStr);
                        if (!isNaN(parsed) && parsed > 0)
                            mtimeMs = parsed;
                    }
                    else if (this.shaCache.has(sidecarPath)) {
                        // Sidecar exists remotely but its content isn't cached yet
                        // (e.g. pulled from remote without a prior stat). Fire-and-forget
                        // a fetch so the NEXT snapshot cycle gets the real value.
                        void this.api.getRaw(sidecarPath).then((raw) => {
                            const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                            this.contentCache.set(sidecarPath, bytes);
                            this._persistContent(sidecarPath, bytes);
                        }).catch(() => { });
                    }
                }
                snapshot.set(relPath, {
                    path: relPath,
                    size: item.size || 0,
                    mtimeMs,
                });
            }
            // Dynamic cleanup: delete orphaned `.mtime` sidecars (a sidecar whose
            // data file no longer exists in the repo). Detection reuses this tree,
            // so no extra API call. Best-effort; failures are logged and ignored.
            const allDataPaths = new Set();
            const sidecarItems = [];
            for (const item of tree) {
                if (item.type === 'tree')
                    continue;
                const dataPath = sidecarToDataPath(item.path);
                if (dataPath)
                    sidecarItems.push({ path: item.path, sha: item.sha });
                else
                    allDataPaths.add(item.path);
            }
            for (const sc of sidecarItems) {
                const dataPath = sidecarToDataPath(sc.path);
                const orphaned = sc.path.endsWith('.mtime.mtime') || !allDataPaths.has(dataPath);
                if (!orphaned)
                    continue;
                const full = '/' + sc.path;
                log.warn(`createSnapshot: pruning orphaned mtime sidecar ${full}`);
                if (typeof this.api.deleteFile === 'function') {
                    void this.api.deleteFile(full, sc.sha, `Prune orphaned mtime sidecar ${full}`)
                        .then(() => { this.shaCache.delete(full); this._deleteSha(full); })
                        .catch((e) => log.warn(`createSnapshot: failed to prune ${full}:`, e));
                }
            }
            return snapshot;
        }
        catch (err) {
            log.warn(`createSnapshot failed:`, err);
            return null;
        }
    }
    /**
    * Recursively delete `.mtime` sidecar files whose data file no longer
    * exists in the Gitee repo (orphaned sidecars). Returns the number of
    * sidecars removed. Safe to call at any time; each deletion is best-effort.
    *
    * NOTE: `createSnapshot()` already prunes orphans on the fly during normal
    * sync; this method forces an explicit, on-demand full cleanup.
    */
    async pruneOrphanedMtimeSidecars(root = '/') {
        const normalizedRoot = root === '/' ? '' : root.replace(/^\/+|\/+$/g, '');
        const tree = await this.api.getTree(true);
        const allDataPaths = new Set();
        const sidecarItems = [];
        for (const item of tree) {
            if (item.type === 'tree')
                continue;
            const dataPath = sidecarToDataPath(item.path);
            if (dataPath)
                sidecarItems.push({ path: item.path, sha: item.sha });
            else
                allDataPaths.add(item.path);
        }
        let removed = 0;
        for (const sc of sidecarItems) {
            if (normalizedRoot && sc.path !== normalizedRoot && !sc.path.startsWith(normalizedRoot + '/'))
                continue;
            const dataPath = sidecarToDataPath(sc.path);
            const orphaned = sc.path.endsWith('.mtime.mtime') || !allDataPaths.has(dataPath);
            if (!orphaned)
                continue;
            const full = '/' + sc.path;
            try {
                await this.api.deleteFile(full, sc.sha, `Prune orphaned mtime sidecar ${full}`);
                this.shaCache.delete(full);
                this._deleteSha(full);
                removed++;
            }
            catch (e) {
                log.warn(`pruneOrphanedMtimeSidecars: failed to delete ${full}:`, e);
            }
        }
        return removed;
    }
    /**
    * Get the blob SHA for a file (from shaCache). Useful for external
* revision checking (e.g. zen-fs-cache getRevision).
*/
    getFileSha(path) {
        return this.shaCache.get(path);
    }
    /**
     * Return a revision token for `path`, implementing the
     * {@link CacheableFileSystem.getRevision} hook for zen-fs-cache.
     *
     * Returns the Git blob SHA from the in-memory `shaCache` — **zero network
     * round-trips**. The SHA is populated during `init()` from a single
     * `getTree` API call and updated on every `write` / `unlink` from the
     * API response.
     *
     * - For **files**: returns the 40-char blob SHA (e.g. `"a1b2c3..."`).
     *   The SHA changes whenever the file content changes, and remains stable
     *   when it doesn't — exactly what the cache needs.
     * - For **directories**: returns `undefined` (Git has no directory-level
     *   blob SHA; tree SHAs are not cached). This causes the cache to re-read
     *   the directory listing.
     * - For **non-existent paths**: returns `undefined` (path is not in
     *   `shaCache`), causing the cache to fall through to a full read which
     *   will produce a 404/ENOENT.
     */
    async getRevision(path) {
        return this.shaCache.get(path);
    }
    /**
     * Check whether the remote branch has new commits since the last baseline.
     *
     * Implements the `SyncableFS.shouldSync()` hook for zen-fs-sync. Compares
     * the latest commit SHA of the configured branch against the cached
     * baseline (`lastCommitSha`). A single API call (`getBranchSha`) is all
     * that's needed — no tree walk.
     *
     * - **SHA unchanged** → `false` (no remote change, skip sync)
     * - **SHA changed** → `true`, and the baseline is updated so subsequent
     *   polls return `false` until the next external commit
     * - **First call (no baseline)** → `true` (triggers initial full sync),
     *   then baseline is set
     * - **API error** → `true` (fail-safe: trigger sync rather than miss updates)
     */
    async shouldSync() {
        try {
            const remoteSha = await this.api.getLatestCommitSha();
            if (!remoteSha)
                return true;
            if (remoteSha === this.lastCommitSha)
                return false;
            this.lastCommitSha = remoteSha;
            this.commitShaStore.set('lastCommitSha', remoteSha).catch(() => { });
            return true;
        }
        catch {
            return true;
        }
    }
}
//# sourceMappingURL=gitee-fs.js.map