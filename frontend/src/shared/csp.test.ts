import { describe, expect, it } from 'vitest'

import { contentSecurityPolicy } from '../../vite.config'

/**
 * The two sites ship different policies from one generator.
 *
 * They used to share a file in public/, which meant one connect-src had to
 * satisfy both — and the only value that does is the union of what either
 * needs. These tests exist to keep that union from creeping back.
 */

const PUBLIC_API = 'https://api.luma-studio.tw'
const ADMIN_API = 'https://admin-api.luma-studio.tw'

function directive(policy: string, name: string): string {
  const found = policy.split('; ').find((part) => part.startsWith(`${name} `))
  if (!found) throw new Error(`no ${name} directive in: ${policy}`)
  return found
}

describe('content security policy', () => {
  it('lets the storefront reach the public API and nothing else', () => {
    const connect = directive(contentSecurityPolicy(PUBLIC_API, PUBLIC_API), 'connect-src')
    expect(connect).toContain(PUBLIC_API)
    expect(connect).not.toContain(ADMIN_API)
  })

  it('lets the back office reach the admin API and nothing else', () => {
    const connect = directive(contentSecurityPolicy(ADMIN_API, PUBLIC_API), 'connect-src')
    expect(connect).toContain(ADMIN_API)
    // The back office loads images from the public API, but never fetches
    // from it — that is img-src's job, not connect-src's.
    expect(connect).not.toContain(`${PUBLIC_API} `)
  })

  it('lets both sites show images served by the public API', () => {
    for (const api of [PUBLIC_API, ADMIN_API]) {
      expect(directive(contentSecurityPolicy(api, PUBLIC_API), 'img-src')).toContain(PUBLIC_API)
    }
  })

  it('keeps the directives that have no reason to vary', () => {
    const policy = contentSecurityPolicy(ADMIN_API, PUBLIC_API)
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    // Widening this to 'self' would be the easy way to make a payment form
    // work, and the wrong one — name the gateway instead.
    expect(policy).toContain("form-action 'none'")
  })

  it('does not allow inline script', () => {
    expect(directive(contentSecurityPolicy(PUBLIC_API, PUBLIC_API), 'script-src')).not.toContain('unsafe-inline')
  })
})
