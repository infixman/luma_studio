import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

/**
 * Two sites out of one project.
 *
 * The storefront and the back office are separate deployments on separate
 * hostnames, but they share components, types and the API client, so they
 * stay one npm project with one dependency tree. `--mode admin` swaps the
 * HTML entry and the output directory; everything else is identical.
 *
 * Vite names an emitted HTML file after its source, so the admin build's
 * shell lands at dist/admin/admin.html rather than index.html. Its Worker
 * knows that; see the SHELL constant in worker/admin.ts.
 */
export default defineConfig(({ mode }) => {
  const admin = mode === 'admin'

  return {
    plugins: [preact()],
    build: {
      outDir: admin ? 'dist/admin' : 'dist/storefront',
      // No sourcemaps in the deployed bundle: they are three times the size of
      // the code and publish the original source to anyone who opens devtools.
      sourcemap: false,
      emptyOutDir: true,
      rollupOptions: { input: { index: admin ? 'admin.html' : 'index.html' } },
    },
    server: { port: admin ? 5174 : 5173, strictPort: true },
  }
})
