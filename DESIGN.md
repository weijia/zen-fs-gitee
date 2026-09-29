# zen-fs-gitee — Design Document

## 1. Overview

This document describes how `GiteeFS` preserves millisecond-precision file
modification time (`mtime`) across sync, even though the underlying Git
repository has no per-file mtime metadata.

The approach mirrors `zen-fs-remotestoragejs` (see its `DESIGN.md` §2
"Precise mtime"): an application-level `.mtime` sidecar file stores the real
mtime so the `zen-fs-sync` engine can compare source/target mtimes reliably.

## 2. The mtime problem (Gitee / Git limitation)

- Git stores content in blobs addressed by SHA-1; it has **no per-file
  modification-time metadata**. The only time available is the commit time.
- Gitee's Content API (`PUT /repos/{owner}/{repo}/contents/{path}`) does not
  accept a client-specified mtime, and a file's effective time on Gitee is the
  commit time of the last write.
- If the target backend loses the source's real mtime (falls back to commit
  time), the sync engine sees `source.mtimeMs !== target.mtimeMs` on every
  cycle and treats the file as "modified", triggering a re-PUT even when the
  content is identical — producing empty / "no-diff" commits on Gitee.

## 3. Design: `.mtime` sidecar

For each data file `/foo/bar.json`, a sidecar file `/foo/.bar.json.mtime`
stores the precise mtime:

```
/foo/bar.json        ← file content
/foo/.bar.json.mtime ← mtimeMs as a plain string (ms since epoch)
```

Helpers live in `src/utils.ts`:
- `mtimePathFor(filePath)` → `/foo/.bar.json.mtime`
- `isMtimeSidecar(name)` → `true` for `*.mtime` files
- `sidecarToDataPath(sidecarPath)` → reverse mapping

Lifecycle in `src/gitee-fs.ts`:
- **Write**: `writeFileWithMtime()` (lines ~628–679) writes the data file
  **and** the sidecar via the Contents API.
- **Read**: `stat()` (lines ~540–603) resolves mtime with this priority:
  1. cached `mtimeCache` entry (if blob SHA unchanged)
  2. `.mtime` sidecar file (most precise)
  3. Commits API `last commit date` (fallback — commit time, not real mtime)
  4. inode default
- **Delete**: `remove()` / `removeSync()` delete the data file and the
  sidecar together.

## 4. Known issue: `write()` / `writeSync()` do NOT write the sidecar

The generic write paths are broken with respect to mtime preservation:

- `write()` (lines ~450–479) and `writeSync()` (lines ~481–512) write **only**
  the data file. They never create or update the `.mtime` sidecar.
- Only the dedicated `writeFileWithMtime()` method writes the sidecar.
- `zen-fs-config`'s adapters (`backendToSyncableFS`, `cachedFSToSyncableFS`)
  implement `writeFileWithMtime` by passing `{ mtime }` as an *option* to
  `backend.writeFile()` — they do **not** delegate to the backend's own
  `writeFileWithMtime` method. GiteeFS's `write()` ignores that option and
  does not write a sidecar.

**Effect**: files pushed to Gitee via the normal write path end up with **no**
`.mtime` sidecar. On the next sync, `stat()` cannot read a sidecar and falls
back to the Commits API, so `target.mtimeMs` becomes the commit time (e.g.
`1785647160000`) while `source.mtimeMs` is the real timestamp
(`1785066849718`). They never match → the sync engine re-PUTs the file every
cycle, producing the "Update … 无差异 / no-diff" commits seen on Gitee.

> Note: `createSnapshot()` (lines ~704–755) additionally uses
> `shaHash(blobSha)` as an mtime proxy instead of reading the sidecar. That is
> a separate hazard — if the sync engine ever compares against that snapshot,
> the synthetic hash is also incompatible with the source's real mtime.

## 5. Fix

Make `write()` / `writeSync()` also write the `.mtime` sidecar (gated by the
same precise-mtime flag), mirroring `RemoteStorageFileSystem.writeFile`
(`zen-fs-remotestoragejs/src/RemoteStorageFileSystem.ts`), whose `writeFile`
writes the sidecar by default. This closes the loop so that regardless of
whether the sync engine calls `writeFile` or `writeFileWithMtime`, the sidecar
is always persisted and `stat()` returns the real mtime.

See also `zen-fs-config/DESIGN.md` §13 "Mtime Preservation During Sync" and
its backend status table.

> **Status**: Implemented in `zen-fs-gitee@1.2.17`. `write()` / `writeSync()`
> now persist the `.mtime` sidecar, and `writeFile` / `writeFileSync` forward
> `options.mtime` into the sidecar — so the real mtime survives cross-backend
> sync and the "no-diff" re-PUTs no longer occur.
