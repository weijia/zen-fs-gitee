import { describe, it, expect } from 'vitest';
import { encodeBase64, decodeBase64, apiPath } from '../src/utils.js';

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
});
