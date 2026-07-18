# zen-fs-gitee

A [ZenFS](https://github.com/zen-fs/core) backend that maps file system operations to a **Gitee** repository via the Gitee REST API v5.

This allows you to read and write files in a Gitee repo directly from the browser (or Node.js) using ZenFS's standard `fs` API.

## Installation

```bash
npm install zen-fs-gitee @zenfs/core
```

## Usage

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
    }
  }
});

// Read a file
const content = fs.readFileSync('/repo/README.md', 'utf-8');

// Write a file
fs.writeFileSync('/repo/src/hello.ts', 'export const hello = "world";');

// List directory
const files = fs.readdirSync('/repo/src');
```

## API Reference

### `Gitee` Backend

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `token` | `string` | Yes | Gitee personal access token. Create one at [Gitee Settings](https://gitee.com/profile/personal_access_tokens). |
| `owner` | `string` | Yes | Repository owner (username or organization). |
| `repo` | `string` | Yes | Repository name. |
| `branch` | `string` | No | Target branch. Defaults to `master`. |
| `baseUrl` | `string` | No | Gitee API base URL. Defaults to `https://gitee.com/api/v5`. |
| `disableAsyncCache` | `boolean` | No | If `true`, disables preloading file contents. Sync reads will throw `EAGAIN` until the file is read asynchronously. |

## How it Works

- On mount, the backend fetches the repository's git tree and builds an in-memory `Index` of all files and directories.
- By default, all file contents are preloaded into memory so that **synchronous reads** work out of the box.
- Writes are translated to `POST` (new file) or `PUT` (update existing file) requests against the Gitee Contents API.
- Each write creates a new commit on the target branch.

## Notes

- Gitee has rate limits (~180 requests per 3 minutes for authenticated users).
- Directory creation on Gitee is implicit: directories are created automatically when a file is placed inside them.
- Hard links and symbolic links are not supported (`ENOSYS`).
- The `writeFileSync` and `removeSync` methods update the local cache immediately and trigger background API calls.

## License

MIT
