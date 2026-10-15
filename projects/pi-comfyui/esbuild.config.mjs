// Build script: two bundles only — the pi extension (src/extension) is loaded
// directly by pi via jiti and must NOT be built.
//
// - server bundle: everything external except our own sources; pi-web stays a
//   runtime import (resolved from the sessiond host), same as captains-log.
// - browser bundle: single ESM file; lit is inlined; pi-web is type-only and
//   erased at build time.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const server = {
    ...common,
    entryPoints: ['src/plugin/server/index.ts'],
    platform: 'node',
    outfile: 'dist/plugin/server/index.js',
    packages: 'external',
    external: ['@jmfederico/pi-web'],
};

/** @type {import('esbuild').BuildOptions} */
const browser = {
    ...common,
    entryPoints: ['src/plugin/browser/index.ts'],
    platform: 'browser',
    outfile: 'dist/plugin/browser/index.js',
};

if (watch) {
    const ctxs = await Promise.all([esbuild.context(server), esbuild.context(browser)]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[pi-comfyui] watching…');
} else {
    await Promise.all([esbuild.build(server), esbuild.build(browser)]);
}
