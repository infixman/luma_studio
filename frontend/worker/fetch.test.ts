import { describe, expect, it } from 'vitest'

import worker from './storefront'

interface Asset {
  status: number
  body?: string
  headers?: Record<string, string>
}

/**
 * Stands in for the static-asset binding. The real one answers 404 for any
 * path that is not a file on disk, which is what sends client-side routes to
 * the Worker.
 */
function assetsBinding(files: Record<string, Asset>) {
  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      const file = files[path]
      if (!file) return new Response('not found', { status: 404 })
      return new Response(file.body ?? '', {
        status: file.status,
        headers: { 'content-type': 'text/html', ...(file.headers ?? {}) },
      })
    },
  }
}

const SHELL = '<!doctype html><html><head><title>Luma Studio</title></head><body><div id="app"></div></body></html>'

function env(files: Record<string, Asset> = { '/index.html': { status: 200, body: SHELL } }) {
  return {
    ASSETS: assetsBinding(files),
    API_BASE: 'https://api.example.test',
    ADMIN_ORIGIN: 'https://admin.luma-studio.tw',
  } as never
}

function get(path: string, userAgent?: string): Request {
  return new Request(`https://luma-studio.tw${path}`, userAgent ? { headers: { 'user-agent': userAgent } } : undefined)
}

/** A user agent that asks for preview tags, so those tests get them. */
const CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
const BROWSER =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/**
 * Replaces global fetch for the metadata lookups the Worker makes.
 *
 * The answer may be a value for every URL, or a function of the URL when a
 * test cares which endpoint was asked. Returning undefined stands for a 404,
 * which is what the API says about a path no page claims.
 */
function stubApi(answer: unknown | Error | ((url: string) => unknown)) {
  const original = globalThis.fetch
  calls.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const value = typeof answer === 'function' ? (answer as (url: string) => unknown)(url) : answer
    if (value instanceof Error) throw value
    if (value === undefined) return new Response('{"error":"Not found"}', { status: 404 })
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

/** Every API URL the Worker asked for since the last stubApi call. */
const calls: string[] = []

const profile = { displayName: '喬喬老師', bio: '台中開課\n兒童美術', avatarPath: '/bio-link-assets/a.jpg' }

const page = {
  title: '關於我們',
  path: '/about',
  showHeader: true,
  showFooter: true,
  shareDescription: '台中與桃園的繪畫教室\n兒童美術與成人肌理畫',
  shareImagePath: '/media-assets/about.jpg',
  blocks: [],
}

const product = {
  slug: 'pastel-set',
  title: '粉彩組',
  description: '十二色，附收納盒',
  images: [{ path: '/shop-assets/pastel.jpg', alt: '粉彩組' }],
  variants: [],
  categories: [],
}

describe('serving the built site', () => {
  it('returns a real file as it comes', async () => {
    const response = await worker.fetch(
      get('/assets/app.js'),
      env({ '/assets/app.js': { status: 200, body: 'console.log(1)', headers: { 'content-type': 'text/javascript' } } }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console.log(1)')
  })

  it('serves the shell for a client-side route instead of redirecting', async () => {
    // These shipped as a 307 back to the home page: the asset router answers
    // a request for /index.html with a redirect, and the Worker passed it on.
    const response = await worker.fetch(get('/ibon_print/20260721_soda'), env())
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('<div id="app">')
  })

  it.each(['/ibon_print/20260721_soda', '/card', '/anything-else'])(
    'serves the shell for %s',
    async (path) => {
      const response = await worker.fetch(get(path), env())
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
    },
  )

  it('refuses to pass a redirect through as the shell', async () => {
    const response = await worker.fetch(
      get('/anything-else'),
      env({ '/index.html': { status: 307, headers: { location: '/' } } }),
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps the security headers the asset layer sets', async () => {
    const response = await worker.fetch(
      get('/anything-else'),
      env({ '/index.html': { status: 200, body: SHELL, headers: { 'x-frame-options': 'DENY' } } }),
    )
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('the back office moved hosts', () => {
  it.each([
    ['/admin', 'https://admin.luma-studio.tw/'],
    ['/admin/', 'https://admin.luma-studio.tw/'],
    ['/admin/bio-link', 'https://admin.luma-studio.tw/bio-link'],
  ])('forwards %s permanently', async (path, destination) => {
    const response = await worker.fetch(get(path), env())
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe(destination)
  })

  it('does not catch paths that merely start with the same letters', async () => {
    const response = await worker.fetch(get('/administrivia'), env())
    expect(response.status).toBe(200)
  })
})

describe('link previews on /card', () => {
  it('writes the profile into the head', async () => {
    const restore = stubApi(profile)
    try {
      const html = await (await worker.fetch(get('/card', CRAWLER), env())).text()
      expect(html).toContain('<meta property="og:title" content="喬喬老師 | 苒光繪誌">')
      expect(html).toContain('property="og:image" content="https://luma-studio.tw/assets/share-card.png"')
      expect(html).toContain('<title>喬喬老師 | 苒光繪誌</title>')
      // The bio's line breaks cannot survive in a preview card.
      expect(html).toContain('content="台中開課 兒童美術"')
    } finally {
      restore()
    }
  })

  it('escapes what it injects', async () => {
    const restore = stubApi({ displayName: '"><script>alert(1)</script>', bio: 'a & b', avatarPath: null })
    try {
      const html = await (await worker.fetch(get('/card', CRAWLER), env())).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&quot;&gt;&lt;script&gt;')
      expect(html).toContain('content="a &amp; b"')
    } finally {
      restore()
    }
  })

  it('still serves the page when the API is unreachable', async () => {
    // A preview is worth less than the page working.
    const restore = stubApi(new Error('network down'))
    try {
      const response = await worker.fetch(get('/card', CRAWLER), env())
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('og:title')
    } finally {
      restore()
    }
  })

  it('does not make a person wait for the API', async () => {
    // The browser fetches the profile itself; blocking the HTML on a second
    // round trip only delays the first paint.
    const restore = stubApi(profile)
    try {
      const response = await worker.fetch(get('/card', BROWSER), env())
      expect(response.status).toBe(200)
      expect(calls).toEqual([])
      expect(await response.text()).not.toContain('og:title')
    } finally {
      restore()
    }
  })

})

describe('link previews on custom pages', () => {
  it('asks the public API for the page at this path', async () => {
    const restore = stubApi(page)
    try {
      await worker.fetch(get('/about', CRAWLER), env())
      expect(calls).toEqual(['https://api.example.test/api/pages?path=%2Fabout'])
    } finally {
      restore()
    }
  })

  it('writes the page card into the head', async () => {
    const restore = stubApi(page)
    try {
      const html = await (await worker.fetch(get('/about', CRAWLER), env())).text()
      expect(html).toContain('<title>關於我們 | 苒光繪誌</title>')
      expect(html).toContain('<meta property="og:title" content="關於我們 | 苒光繪誌">')
      expect(html).toContain('content="台中與桃園的繪畫教室 兒童美術與成人肌理畫"')
      expect(html).toContain('<meta property="og:url" content="https://luma-studio.tw/about">')
      // The image is served by the API host, so a path alone would resolve
      // against the site and 404 in whichever app is drawing the card.
      expect(html).toContain('content="https://api.example.test/media-assets/about.jpg"')
    } finally {
      restore()
    }
  })

  it('falls back to the studio card when the page has no image of its own', async () => {
    const restore = stubApi({ ...page, shareDescription: '', shareImagePath: null })
    try {
      const html = await (await worker.fetch(get('/about', CRAWLER), env())).text()
      expect(html).toContain('content="https://luma-studio.tw/assets/share-card.png"')
      // Nothing written means nothing said, rather than an empty description
      // tag for a crawler to show as a blank line.
      expect(html).not.toContain('og:description')
    } finally {
      restore()
    }
  })

  it('asks the home endpoint for the front page', async () => {
    // The most-shared URL of the lot, and no path of its own to ask by.
    const restore = stubApi(page)
    try {
      await worker.fetch(get('/', CRAWLER), env())
      expect(calls).toEqual(['https://api.example.test/api/pages/home'])
    } finally {
      restore()
    }
  })

  it('serves a path no page claims anyway', async () => {
    const restore = stubApi(undefined)
    try {
      const response = await worker.fetch(get('/nothing-here', CRAWLER), env())
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<div id="app">')
    } finally {
      restore()
    }
  })

  it('serves the page when the metadata lookup fails', async () => {
    // A metadata miss must never become a broken link.
    const restore = stubApi(new Error('network down'))
    try {
      const response = await worker.fetch(get('/about', CRAWLER), env())
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('og:title')
    } finally {
      restore()
    }
  })

  it('does not make a person wait for the API', async () => {
    const restore = stubApi(page)
    try {
      const response = await worker.fetch(get('/about', BROWSER), env())
      expect(response.status).toBe(200)
      expect(calls).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('link previews on product pages', () => {
  it('shares the product as itself', async () => {
    const restore = stubApi(product)
    try {
      const html = await (await worker.fetch(get('/shop/pastel-set', CRAWLER), env())).text()
      expect(calls).toEqual(['https://api.example.test/api/products/pastel-set'])
      expect(html).toContain('<meta property="og:type" content="product">')
      expect(html).toContain('<meta property="og:title" content="粉彩組 | 苒光繪誌">')
      expect(html).toContain('content="十二色，附收納盒"')
      expect(html).toContain('content="https://api.example.test/shop-assets/pastel.jpg"')
    } finally {
      restore()
    }
  })

  it('still shares a product nobody has written anything for', async () => {
    // The title and the cover are the product's own, so an untouched product
    // shares as itself rather than as a blank card.
    const restore = stubApi({ slug: 'plain', title: '素描本', description: '', images: [] })
    try {
      const html = await (await worker.fetch(get('/shop/plain', CRAWLER), env())).text()
      expect(html).toContain('<meta property="og:title" content="素描本 | 苒光繪誌">')
      expect(html).toContain('content="https://luma-studio.tw/assets/share-card.png"')
    } finally {
      restore()
    }
  })

  it('serves the product page when the lookup fails', async () => {
    const restore = stubApi(new Error('network down'))
    try {
      const response = await worker.fetch(get('/shop/pastel-set', CRAWLER), env())
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<div id="app">')
    } finally {
      restore()
    }
  })

  it.each(['/shop', '/shop/c/art-kits'])('leaves %s alone, and asks nothing about it', async (path) => {
    // The index and the category pages are the shop's own furniture; only a
    // product is somebody's shared link.
    const restore = stubApi(product)
    try {
      const html = await (await worker.fetch(get(path, CRAWLER), env())).text()
      expect(html).not.toContain('og:title')
      expect(calls).toEqual([])
    } finally {
      restore()
    }
  })
})

/**
 * Who may frame this site, checked on the response that is actually sent.
 *
 * These exist because the rule used to live in `_headers` as a `/__preview/*`
 * block, and could never fire: every SPA route is served by fetching
 * `/index.html`, so Pages matches the headers against *that* path and only the
 * `/*` block applies. The generator had tests, they passed, and the feature
 * was dead. Assert the header on the Response or assert nothing.
 */
describe('who may frame the storefront', () => {
  const shellWithHeaders = {
    '/index.html': {
      status: 200,
      body: SHELL,
      headers: {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      },
    },
  }

  it('refuses every frame on an ordinary page', async () => {
    const response = await worker.fetch(get('/about'), env(shellWithHeaders))
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('lets the back office frame the preview route', async () => {
    const response = await worker.fetch(get('/__preview/abcdefghijklmnopqrstuvwx'), env(shellWithHeaders))
    // X-Frame-Options cannot name another host, so it has to go entirely.
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://admin.luma-studio.tw',
    )
  })

  it('gives up nothing else to allow it', async () => {
    const response = await worker.fetch(get('/__preview/abcdefghijklmnopqrstuvwx'), env(shellWithHeaders))
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("default-src 'self'")
    expect(policy).not.toContain("frame-ancestors 'none'")
  })

  it('does not relax a path that merely starts the same way', async () => {
    // `/__previewer` is not the preview route, and the check is a prefix.
    const response = await worker.fetch(get('/__previewing'), env(shellWithHeaders))
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})
