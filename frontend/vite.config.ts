import preact from '@preact/preset-vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', sourcemap: true },
  server: { port: 5173, strictPort: true },
})
