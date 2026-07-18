/** @module */

export { GiteeFS } from './gitee-fs.js';
export type { GiteeOptions } from './types.js';

import type { Backend } from '@zenfs/core';
import { GiteeFS } from './gitee-fs.js';
import type { GiteeOptions } from './types.js';

const _Gitee: Backend<GiteeFS, GiteeOptions> = {
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
	async create(options: GiteeOptions) {
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
export const Gitee: Backend<GiteeFS, GiteeOptions> = _Gitee;

export default Gitee;
