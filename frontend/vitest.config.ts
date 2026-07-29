import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Most tests cover pure modules and run without a DOM. A page whose
    // behaviour *is* what it renders — which panel appears, which control is
    // disabled — cannot be checked that way, so `.test.tsx` files render for
    // real. They opt in per file with `// @vitest-environment happy-dom`;
    // the default stays `node` so the pure tests keep their faster start.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'worker/**/*.test.ts'],
    environment: 'node',
  },
})
