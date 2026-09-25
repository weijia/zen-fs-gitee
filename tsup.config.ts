import { defineConfig } from 'tsup';

export default defineConfig({
	entry: { 'zen-fs-gitee': 'src/index.ts' },
	format: ['iife'],
	globalName: 'ZenFSGitee',
	outDir: 'dist',
	sourcemap: true,
	target: 'es2022',
	platform: 'browser',
	// Bundle all dependencies for browser IIFE usage
	external: [],
});
