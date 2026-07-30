import { defineConfig } from 'vitest/config'

/**
 * Tests run in plain Node against the pure modules under `src/shared`, plus the
 * renderer's components in happy-dom. Nothing here starts Electron: a test that
 * needs a real window is testing Electron rather than this tool.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
})
