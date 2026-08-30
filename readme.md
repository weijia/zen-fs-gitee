# zen-fs-gitee

A [ZenFS](https://github.com/weijia/zen-fs) backend that maps file system operations to a **Gitee** repository via the Gitee REST API v5.

Read and write files in a Gitee repo directly from the browser or Node.js using ZenFS's standard `fs` API. Works seamlessly with `zen-fs-sync` for cross-backend synchronization.

## Features

- **Full file system API** — read, write, delete, stat, readdir, and more, all backed by a real Git repository
- **Synchronous reads** — file contents are preloaded into memory on mount, so `readFileSync` works out of the box
- **Async writes** — `writeFileSync` and `removeSync` update the local cache immediately and queue API calls in the background
- **Commit history** — every write creates a new commit on the target branch
- **mtime from commits** — `stat()` returns the real last commit time for each file (cached after first lookup)
- **Browser & Node.js** — works in both environments
- **Sync-ready** — compatible with `zen-fs-sync` for bi-directional sync with other backends

## Installation

```bash
npm install zen-fs-gitee @zenfs/core
```

## Usage

### Basic setup with ZenFS

```typescript
import { configure, fs } from '@zenfs/core';
import { Gitee } from 'zen-fs-gitee';

await configure({
  mounts: {
    '/repo': {
      backend: Gitee,
      token: 'YOUR_GITEE_PERSONAL_ACCESS_TOKEN',
      owner: 'gitee-username',
      repo: 'repository-name',
      branch: 'master',           // optional, defaults to master
      disableAsyncCache: false,   // optional, preload file contents for sync reads
    },
  },
});

// Read a file
const content = fs.readFileSync('/repo/README.md', 'utf-8');

// Write a file
fs.writeFileSync('/repo/src/hello.ts', 'export const hello = "world";');

// List directory
const files = fs.readdirSync('/repo/src');

// Delete a file
fs.unlinkSync('/repo/src/old-file.txt');
```

### With zen-fs-sync

```typescript
import { SyncPair, SyncDirection } from 'zen-fs-sync';
import { Gitee } from 'zen-fs-gitee';

const giteeFS = await Gitee.create({
  token: 'your-token',
  owner: 'your-name',
  repo: 'config-repo',
  branch: 'main',
});

// Sync local IndexedDB with a Gitee repo
const pair = new SyncPair(localFS, giteeFS, {
  direction: SyncDirection.BiDirectional,
  pollIntervalMs: 300000, // 5 minutes
});

pair.watch();
```

## API Reference

### Gitee Backend Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `token` | `string` | Yes | Gitee personal access token. Create one at [Gitee Settings](https://gitee.com/profile/personal_access_tokens). |
| `owner` | `string` | Yes | Repository owner (username or organization). |
| `repo` | `string` | Yes | Repository name. |
| `branch` | `string` | No | Target branch. Defaults to `master`. |
| `baseUrl` | `string` | No | Gitee API base URL. Defaults to `https://gitee.com/api/v5`. |
| `disableAsyncCache` | `boolean` | No | If `true`, disables preloading file contents. Sync reads will throw `EAGAIN` until the file is read asynchronously. |

### Methods

| Method | Description |
|--------|-------------|
| `Gitee.create(options)` | Static factory — creates and initializes the backend |
| `init()` | Loads the repo tree and builds the in-memory index |
| `preloadContents()` | Preloads all file contents into memory for sync reads |
| `ready()` | Waits for initialization to complete |
| `sync()` | Waits for all pending background write operations to finish |
| `getFileSha(path)` | Returns the blob SHA for a file (useful for revision checks) |

## How It Works

1. **On mount**, the backend fetches the repository's git tree and builds an in-memory `Index` of all files and directories.
2. **By default**, all file contents are preloaded into memory so that **synchronous reads** work out of the box.
3. **Writes** are translated to `POST` (new file) or `PUT` (update existing file) requests against the Gitee Contents API.
4. **Each write** creates a new commit on the target branch.
5. **Background sync** — synchronous methods (`writeFileSync`, `removeSync`) update the local cache immediately and queue API calls. Call `sync()` to wait for all pending operations.

## Notes

- Gitee has rate limits (~180 requests per 3 minutes for authenticated users).
- Directory creation on Gitee is implicit: directories are created automatically when a file is placed inside them.
- Hard links and symbolic links are not supported (`ENOSYS`).
- The `writeFileSync` and `removeSync` methods update the local cache immediately and trigger background API calls.

## License

MIT
