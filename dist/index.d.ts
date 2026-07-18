/** @module */
export { GiteeFS } from './gitee-fs.js';
export type { GiteeOptions } from './types.js';
import type { Backend } from '@zenfs/core';
import { GiteeFS } from './gitee-fs.js';
import type { GiteeOptions } from './types.js';
/**
 * The Gitee backend for ZenFS.
 *
 * @example
 * ```typescript
 * import { configure } from '@zenfs/core';
 * import { Gitee } from 'zen-fs-gitee';
 *
 * await configure({
 *   mounts: {
 *     '/repo': {
 *       backend: Gitee,
 *       token: 'YOUR_GITEE_TOKEN',
 *       owner: 'your-name',
 *       repo: 'your-repo',
 *     }
 *   }
 * });
 * ```
 *
 * @category Backends and Configuration
 */
export declare const Gitee: Backend<GiteeFS, GiteeOptions>;
export default Gitee;
//# sourceMappingURL=index.d.ts.map