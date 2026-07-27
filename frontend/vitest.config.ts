import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only the pure modules are covered: everything else needs a browser or
    // the Workers runtime, and faking those buys less than it costs.
    include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
    environment: 'node',
  },
})
