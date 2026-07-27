import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [preact()],
  // No sourcemaps in the deployed bundle: they are three times the size of
  // the code and publish the original source to anyone who opens devtools.
  build: { outDir: 'dist', sourcemap: false },
  server: { port: 5173, strictPort: true },
})
