import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../../shared/styles/base.css', import.meta.url)), 'utf8')

describe('storefront landing routes', () => {
  it('does not turn the route-marked body into the centred empty-page grid', () => {
    expect(css).toContain('main.landing {')
    expect(css).not.toMatch(/(?:^|\n)\.landing\s*\{/)
  })
})
