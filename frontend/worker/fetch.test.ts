import { describe, expect, it } from 'vitest'

import worker from './index'

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
  return { ASSETS: assetsBinding(files), API_BASE: 'https://api.example.test' } as never
}

function get(path: string): Request {
  return new Request(`https://luma-studio.tw${path}`)
}

/** Replaces global fetch for the profile lookup the Worker makes. */
function stubApi(response: unknown | Error) {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const profile = { displayName: '喬喬老師', bio: '台中開課\n兒童美術', avatarPath: '/bio-link-assets/a.jpg' }

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
    // /admin shipped as a 307 back to the home page: the asset router answers
    // a request for /index.html with a redirect, and the Worker passed it on.
    const response = await worker.fetch(get('/admin'), env())
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('<div id="app">')
  })

  it.each(['/admin', '/admin/bio-link', '/ibon_print/20260721_soda', '/anything-else'])(
    'serves the shell for %s',
    async (path) => {
      const response = await worker.fetch(get(path), env())
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
    },
  )

  it('refuses to pass a redirect through as the shell', async () => {
    const response = await worker.fetch(get('/admin'), env({ '/index.html': { status: 307, headers: { location: '/' } } }))
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps the security headers the asset layer sets', async () => {
    const response = await worker.fetch(
      get('/admin'),
      env({ '/index.html': { status: 200, body: SHELL, headers: { 'x-frame-options': 'DENY' } } }),
    )
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})

describe('link previews on /bio_link', () => {
  it('writes the profile into the head', async () => {
    const restore = stubApi(profile)
    try {
      const html = await (await worker.fetch(get('/bio_link'), env())).text()
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
      const html = await (await worker.fetch(get('/bio_link'), env())).text()
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
      const response = await worker.fetch(get('/bio_link'), env())
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('og:title')
    } finally {
      restore()
    }
  })

  it('leaves other routes without preview tags', async () => {
    const restore = stubApi(profile)
    try {
      const html = await (await worker.fetch(get('/admin'), env())).text()
      expect(html).not.toContain('og:title')
    } finally {
      restore()
    }
  })
})
