/**
 * Configuration options for the Gitee backend.
 */
export interface GiteeOptions {
	/** Gitee personal access token. Create one at https://gitee.com/profile/personal_access_tokens */
	token: string;
	/** Repository owner (username or organization). */
	owner: string;
	/** Repository name. */
	repo: string;
	/** Branch name. Defaults to `master`. */
	branch?: string;
	/** Base URL for the Gitee API. Defaults to `https://gitee.com/api/v5`. */
	baseUrl?: string;
	/**
	 * If true, `stat()` and the snapshot builder use the Gitee **commit time** as
	 * the file's modification time and skip probing the `.mtime` sidecar file
	 * entirely. This avoids one raw-API request (and a harmless-but-noisy 404)
	 * per file when sidecars are not used. Defaults to `false` (preserve the
	 * sidecar-based real mtime when available, falling back to commit time).
	 */
	useCommitTimeAsMtime?: boolean;
	/**
	 * If true, disables preloading file contents into memory cache.
	 * Sync reads will throw `EAGAIN` until the file is explicitly read asynchronously.
	 */
	disableAsyncCache?: boolean;
}
