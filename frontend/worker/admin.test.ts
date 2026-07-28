import { describe, expect, it } from 'vitest'

import worker from './admin'

interface Asset {
  status: number
  body?: string
  headers?: Record<string, string>
}

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

const SHELL = '<!doctype html><html><head><title>Luma Studio 管理</title></head><body><div id="app"></div></body></html>'

/** The build emits admin.html, not index.html — that is the point of these tests. */
function env(files: Record<string, Asset> = { '/admin.html': { status: 200, body: SHELL } }) {
  return { ASSETS: assetsBinding(files) } as never
}

function get(path: string): Request {
  return new Request(`https://admin.luma-studio.tw${path}`)
}

describe('serving the back office', () => {
  it('returns a real file as it comes', async () => {
    const response = await worker.fetch(
      get('/assets/app.js'),
      env({ '/assets/app.js': { status: 200, body: 'console.log(1)', headers: { 'content-type': 'text/javascript' } } }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console.log(1)')
  })

  it.each(['/', '/card', '/anything-else'])('serves the shell for %s', async (path) => {
    const response = await worker.fetch(get(path), env())
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('<div id="app">')
  })

  it('looks for admin.html rather than index.html', async () => {
    // A build whose shell is named index.html would leave every route dead,
    // and the failure would only show up after a deploy.
    const response = await worker.fetch(get('/card'), env({ '/index.html': { status: 200, body: SHELL } }))
    expect(response.status).toBe(404)
  })

  it('refuses to pass a redirect through as the shell', async () => {
    const response = await worker.fetch(get('/card'), env({ '/admin.html': { status: 307, headers: { location: '/' } } }))
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps the security headers the asset layer sets', async () => {
    const response = await worker.fetch(
      get('/card'),
      env({ '/admin.html': { status: 200, body: SHELL, headers: { 'x-frame-options': 'DENY' } } }),
    )
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})
