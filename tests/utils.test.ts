import { describe, it, expect } from 'vitest';
import {
	encodeBase64,
	decodeBase64,
	apiPath,
	mtimePathFor,
	isMtimeSidecar,
	shaHash,
	sidecarToDataPath,
} from '../src/utils.js';

describe('utils', () => {
	describe('encodeBase64 / decodeBase64', () => {
		it('round-trips text', () => {
			const text = 'Hello, Gitee!';
			const data = new TextEncoder().encode(text);
			const encoded = encodeBase64(data);
			const decoded = decodeBase64(encoded);
			expect(new TextDecoder().decode(decoded)).toBe(text);
		});

		it('round-trips binary data', () => {
			const data = new Uint8Array([0, 1, 255, 128, 64, 32]);
			const encoded = encodeBase64(data);
			const decoded = decodeBase64(encoded);
			expect(decoded).toEqual(data);
		});

		it('handles empty data', () => {
			const data = new Uint8Array(0);
			const encoded = encodeBase64(data);
			expect(encoded).toBe('');
			const decoded = decodeBase64(encoded);
			expect(decoded).toEqual(data);
		});
	});

	describe('apiPath', () => {
		it('strips leading slashes', () => {
			expect(apiPath('/foo/bar')).toBe('foo/bar');
			expect(apiPath('//foo/bar')).toBe('foo/bar');
		});

		it('leaves paths without leading slash unchanged', () => {
			expect(apiPath('foo/bar')).toBe('foo/bar');
		});

		it('handles root path', () => {
			expect(apiPath('/')).toBe('');
		});
	});

	describe('mtimePathFor', () => {
		it('converts a file in the root to a sidecar path', () => {
			expect(mtimePathFor('/config.json')).toBe('/.config.json.mtime');
		});

		it('converts a file in a subdirectory to a sidecar path', () => {
			expect(mtimePathFor('/documents/note.json')).toBe('/documents/.note.json.mtime');
		});

		it('converts a deeply nested file to a sidecar path', () => {
			expect(mtimePathFor('/a/b/c/d.json')).toBe('/a/b/c/.d.json.mtime');
		});

		it('handles a path with no leading slash', () => {
			expect(mtimePathFor('config.json')).toBe('.config.json.mtime');
		});
	});

	describe('isMtimeSidecar', () => {
		it('returns true for a dotted .mtime sidecar filename', () => {
			expect(isMtimeSidecar('.config.json.mtime')).toBe(true);
		});

		it('returns true for a simple .mtime sidecar filename', () => {
			expect(isMtimeSidecar('.note.mtime')).toBe(true);
		});

		it('returns false for a plain filename', () => {
			expect(isMtimeSidecar('config.json')).toBe(false);
		});

		it('returns false when the file ends with .mtime but does not start with a dot', () => {
			expect(isMtimeSidecar('config.mtime')).toBe(false);
		});

		it('returns false when the file starts with a dot but does not end with .mtime', () => {
			expect(isMtimeSidecar('.config.json')).toBe(false);
		});

		it('returns false for an empty string', () => {
			expect(isMtimeSidecar('')).toBe(false);
		});
	});

	describe('shaHash', () => {
		it('returns a positive number for a non-empty sha', () => {
			const result = shaHash('abc123');
			expect(result).toBeGreaterThan(0);
		});

		it('produces different outputs for different inputs', () => {
			expect(shaHash('abc123')).not.toBe(shaHash('def456'));
		});

		it('is deterministic for the same input', () => {
			expect(shaHash('abc123')).toBe(shaHash('abc123'));
		});

		it('returns a value that fits in a 32-bit integer range', () => {
			const result = shaHash('da39a3ee5e6b4b0d3255bfef95601890afd80709');
			expect(Number.isInteger(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(0);
			expect(result).toBeLessThanOrEqual(0x7fffffff);
		});

		it('returns 0 for an empty string', () => {
			expect(shaHash('')).toBe(0);
		});
	});

	describe('sidecarToDataPath', () => {
		it('reverses a sidecar path in a subdirectory', () => {
			expect(sidecarToDataPath('/documents/.note.json.mtime')).toBe('/documents/note.json');
		});

		it('reverses a sidecar path in the root', () => {
			expect(sidecarToDataPath('/.config.json.mtime')).toBe('/config.json');
		});

		it('returns null for a path that is not a sidecar', () => {
			expect(sidecarToDataPath('/config.json')).toBeNull();
		});

		it('returns null when there is no filename between the dot and .mtime', () => {
			expect(sidecarToDataPath('.mtime')).toBeNull();
		});

		it('returns null when the path does not end with .mtime', () => {
			expect(sidecarToDataPath('/.config.json')).toBeNull();
		});
	});
});
