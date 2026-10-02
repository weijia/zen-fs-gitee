/**
 * Convert a Uint8Array to a Base64 string.
 * Compatible with browsers.
 */
export declare function encodeBase64(data: Uint8Array): string;
/**
 * Convert a Base64 string to a Uint8Array.
 */
export declare function decodeBase64(base64: string): Uint8Array;
/**
 * Strip leading slashes from a path for Gitee API usage.
 */
export declare function apiPath(path: string): string;
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
export declare function mtimePathFor(filePath: string): string;
/**
 * Check whether a filename is a .mtime sidecar file.
 *
 * note.json.mtime → true
 * note.json       → false
 */
export declare function isMtimeSidecar(name: string): boolean;
/**
 * Reverse: given a sidecar path, return the data file path.
 *
 * /documents/note.json.mtime → /documents/note.json
 * /nodes/.keep.mtime         → /nodes/.keep
 * Returns null if the path is not a valid sidecar.
 */
export declare function sidecarToDataPath(sidecarPath: string): string | null;
/**
 * Hash a blob SHA to a numeric value for use as mtimeMs proxy.
 * Different content → different SHA → different hash → detected as change.
 */
export declare function shaHash(sha: string): number;
//# sourceMappingURL=utils.d.ts.map