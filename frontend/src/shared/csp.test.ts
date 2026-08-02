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

  it('lets each site show images served by its own API', () => {
    /** The back office draws video thumbnails through the admin Worker, because
     *  a signed URL for a private object is a capability that outlives the page
     *  it was put on. Without this the browser blocks the request before it is
     *  made, and the page shows the fallback for "this encode has no poster" —
     *  a wrong answer that looks like a right one. */
    expect(directive(contentSecurityPolicy(ADMIN_API, PUBLIC_API), 'img-src')).toContain(ADMIN_API)
  })

  it('lets the player play what the gateway serves', () => {
    /** Two separate needs. hls.js feeds the video element through MSE, whose
     *  object URLs are `blob:`; Safari plays the manifest URL directly, which
     *  is on the API host. Neither is covered by default-src 'self', and the
     *  failure is a black rectangle with nothing in the console but a CSP
     *  line nobody was looking at. */
    for (const api of [PUBLIC_API, ADMIN_API]) {
      const media = directive(contentSecurityPolicy(api, PUBLIC_API), 'media-src')
      expect(media).toContain(api)
      expect(media).toContain('blob:')
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

/**
 * The preview route is the one path the storefront lets itself be framed on.
 *
 * These exist because the tempting fix — relaxing frame-ancestors on `/*` —
 * would put /cart, /checkout and /orders back inside somebody else's page,
 * and nothing about the preview working would look any different.
 */
describe('who may frame the storefront', () => {
  const ADMIN = 'https://admin.luma-studio.tw'

  it('refuses every frame by default', () => {
    expect(contentSecurityPolicy(PUBLIC_API, PUBLIC_API)).toContain("frame-ancestors 'none'")
  })

  it('names the back office, and only the back office, when asked', () => {
    const policy = contentSecurityPolicy(PUBLIC_API, PUBLIC_API, { framedBy: ADMIN })
    expect(directive(policy, 'frame-ancestors')).toBe(`frame-ancestors ${ADMIN}`)
  })

  it('gives up nothing else to be framed', () => {
    const framed = contentSecurityPolicy(PUBLIC_API, PUBLIC_API, { framedBy: ADMIN })
    const closed = contentSecurityPolicy(PUBLIC_API, PUBLIC_API)
    const strip = (policy: string) => policy.split('; ').filter((part) => !part.startsWith('frame-ancestors'))
    expect(strip(framed)).toEqual(strip(closed))
  })
})
