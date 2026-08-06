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
 * /documents/note.json → /documents/.note.json.mtime
 * /config.json         → /.config.json.mtime
 */
export function mtimePathFor(filePath: string): string {
	const lastSlash = filePath.lastIndexOf('/');
	const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : '';
	const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
	return `${dir}.${fileName}.mtime`;
}

/**
 * Check whether a filename is a .mtime sidecar file.
 *
 * .note.json.mtime → true
 * note.json        → false
 */
export function isMtimeSidecar(name: string): boolean {
	return name.startsWith('.') && name.endsWith('.mtime');
}

/**
 * Reverse: given a sidecar path, return the data file path.
 *
 * /documents/.note.json.mtime → /documents/note.json
 * Returns null if the path is not a valid sidecar.
 */
export function sidecarToDataPath(sidecarPath: string): string | null {
	const lastSlash = sidecarPath.lastIndexOf('/');
	const dir = lastSlash >= 0 ? sidecarPath.slice(0, lastSlash + 1) : '';
	const fileName = lastSlash >= 0 ? sidecarPath.slice(lastSlash + 1) : sidecarPath;
	if (!fileName.startsWith('.') || !fileName.endsWith('.mtime')) return null;
	const dataFilename = fileName.slice(1, -6); // remove leading '.' and trailing '.mtime'
	if (dataFilename === '') return null; // e.g. '.mtime' has no filename between dot and .mtime
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
