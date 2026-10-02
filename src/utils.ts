/**
 * Convert a Uint8Array to a Base64 string.
 * Compatible with browsers.
 */
export function encodeBase64(data: Uint8Array): string {
	let binary = '';
	const len = data.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(data[i]);
	}
	return btoa(binary);
}

/**
 * Convert a Base64 string to a Uint8Array.
 */
export function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const len = binary.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * Strip leading slashes from a path for Gitee API usage.
 */
export function apiPath(path: string): string {
	return path.replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// mtime Sidecar Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the .mtime sidecar path for a given file path.
 *
 * /documents/note.json → /documents/note.json.mtime
 * /documents/.note.json → /documents/.note.json.mtime
 * /config.json         → /config.json.mtime
 * /.keep               → /.keep.mtime
 *
 * NOTE: the sidecar is the data file name with `.mtime` appended — NO leading
 * dot. This round-trips every name (including dotfiles) through
 * {@link sidecarToDataPath}: `.keep` → `.keep.mtime` → `.keep`. The previous
 * leading-dot convention (`.keep` → `.keep.mtime`, then reverse-stripping the
 * leading dot → `keep`) could not round-trip dotfiles, hence the pure-suffix
 * form. Trade-off: a user file literally named `*.mtime` is treated as a
 * sidecar.
 */
export function mtimePathFor(filePath: string): string {
  // Guard against nested sidecars: callers must pass the *data* file path, not
  // a sidecar path. If a `.mtime` path slips through, warn and return it
  // unchanged instead of producing a doubly-suffixed `*.mtime.mtime`.
  if (filePath.endsWith('.mtime')) {
    console.warn(
      `[zen-fs-gitee] mtimePathFor received a path that already ends with ".mtime" (${filePath}); ` +
      `returning it unchanged to avoid a nested sidecar. Pass the data file path instead.`,
    );
    return filePath;
  }
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const mtimeFileName = `${fileName}.mtime`;
  return `${dir}${mtimeFileName}`;
}

/**
 * Check whether a filename is a .mtime sidecar file.
 *
 * note.json.mtime → true
 * note.json       → false
 */
export function isMtimeSidecar(name: string): boolean {
	return name.endsWith('.mtime') && name.length > 6;
}

/**
 * Reverse: given a sidecar path, return the data file path.
 *
 * /documents/note.json.mtime → /documents/note.json
 * /nodes/.keep.mtime         → /nodes/.keep
 * Returns null if the path is not a valid sidecar.
 */
export function sidecarToDataPath(sidecarPath: string): string | null {
	const lastSlash = sidecarPath.lastIndexOf('/');
	const dir = lastSlash >= 0 ? sidecarPath.slice(0, lastSlash + 1) : '';
	const fileName = lastSlash >= 0 ? sidecarPath.slice(lastSlash + 1) : sidecarPath;
	if (!fileName.endsWith('.mtime')) return null;
	const dataFilename = fileName.slice(0, -6); // remove trailing '.mtime'
	if (dataFilename === '') return null; // e.g. '.mtime' has no filename
	return `${dir}${dataFilename}`;
}

/**
 * Hash a blob SHA to a numeric value for use as mtimeMs proxy.
 * Different content → different SHA → different hash → detected as change.
 */
export function shaHash(sha: string): number {
	let hash = 0;
	for (let i = 0; i < sha.length; i++) {
		hash = ((hash << 5) - hash + sha.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}
