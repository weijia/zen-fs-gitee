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
