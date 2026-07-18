/** @module */
export { GiteeFS } from './gitee-fs.js';
import { GiteeFS } from './gitee-fs.js';
const _Gitee = {
    name: 'Gitee',
    options: {
        token: { type: 'string', required: true },
        owner: { type: 'string', required: true },
        repo: { type: 'string', required: true },
        branch: { type: 'string', required: false },
        baseUrl: { type: 'string', required: false },
    },
    isAvailable() {
        return typeof globalThis.fetch === 'function';
    },
    async create(options) {
        const fs = new GiteeFS(options);
        await fs.init();
        if (!options.disableAsyncCache) {
            await fs.preloadContents();
        }
        return fs;
    },
};
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
export const Gitee = _Gitee;
export default Gitee;
//# sourceMappingURL=index.js.map