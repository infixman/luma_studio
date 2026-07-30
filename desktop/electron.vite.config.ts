import { resolve } from 'node:path'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * Three separate bundles, because they run in three places with three different
 * sets of privileges.
 *
 * The renderer is the only one that draws anything and the only one that could
 * ever be handed hostile content, so it gets no Node access at all — see
 * `src/main/index.ts`. Anything it needs from the operating system arrives
 * through the small, explicit surface in `src/preload`.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CommonJS, and not by accident. A sandboxed preload script cannot be
        // an ES module — Electron will not load one, and the only symptom is
        // that `window.desktop` is undefined with nothing in the console. This
        // package is `type: module`, so without saying so here the output is
        // `.mjs` and the bridge silently never arrives.
        //
        // The alternative is turning the sandbox off, which is a real loss for
        // a syntax preference.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    resolve: {
      alias: {
        // Preact rather than React, to match the rest of this repository. One
        // less framework for whoever maintains both.
        react: 'preact/compat',
        'react-dom': 'preact/compat',
      },
    },
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  },
})
