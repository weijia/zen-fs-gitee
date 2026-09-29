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

Note: `mtimePathFor` does not double the leading dot — a file whose name
already starts with `.` (e.g. `.gitignore`) yields `.gitignore.mtime`, not
`..gitignore.mtime`. This matches `zen-fs-remotestoragejs`'s `mtimePathFor`.

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
- **Snapshot**: `createSnapshot()` (lines ~752–826) builds the file snapshot
  from the Git tree API. It indexes `.mtime` sidecars (via `sidecarToDataPath`)
  and, for each data file, uses the **real mtime from the sidecar** when its
  content is cached; otherwise it falls back to `shaHash(blobSha)` (a
  content-stable proxy) and fire-and-forget-fetches the sidecar so the next
  snapshot gets the real value. Sidecar files are excluded from the snapshot so
  they never appear as user-visible files.

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

> Note: `createSnapshot()` (lines ~752–826) previously used `shaHash(blobSha)`
> as an mtime proxy instead of reading the sidecar — a separate hazard if the
> sync engine ever compared against that snapshot, since the synthetic hash is
> incompatible with the source's real mtime. **Fixed in `zen-fs-gitee@1.2.18`**:
> it now indexes `.mtime` sidecars (via `sidecarToDataPath`, which correctly
> detects sidecars on directory-prefixed paths) and uses the real mtime, with
> the shaHash proxy only as a fallback. See §5.

## 5. Fix

Make `write()` / `writeSync()` also write the `.mtime` sidecar (gated by the
same precise-mtime flag), mirroring `RemoteStorageFileSystem.writeFile`
(`zen-fs-remotestoragejs/src/RemoteStorageFileSystem.ts`), whose `writeFile`
writes the sidecar by default. This closes the loop so that regardless of
whether the sync engine calls `writeFile` or `writeFileWithMtime`, the sidecar
is always persisted and `stat()` returns the real mtime.

Additionally, `createSnapshot()` now reads the `.mtime` sidecar for the real
mtime instead of relying solely on `shaHash(blobSha)`. It indexes sidecars via
`sidecarToDataPath(item.path)` (which correctly detects sidecars even on
directory-prefixed paths — unlike `isMtimeSidecar(item.path)`, which only
matches strings starting with `.` and therefore missed `/foo/.bar.json.mtime`).
When a sidecar's content is already in `contentCache`, the real mtime is used
directly; otherwise the shaHash proxy is used and the sidecar is fetched
asynchronously so the next snapshot gets the real value. This keeps target-side
mtime comparable with the source's real mtime even on the snapshot-based
comparison path, and also fixes a latent bug where sidecars leaked into the
snapshot as user-visible files.

See also `zen-fs-config/DESIGN.md` §13 "Mtime Preservation During Sync" and
its backend status table.

> **Status**:
> - `write()` / `writeSync()` sidecar fix — `zen-fs-gitee@1.2.17`.
> - `createSnapshot()` sidecar-read fix — `zen-fs-gitee@1.2.18`.
>   Both ensure the real mtime survives cross-backend sync and the "no-diff"
>   re-PUTs no longer occur.
