import { describe, expect, it } from 'vitest'

import worker, { destinationFor } from './legacy'

describe('the address that was handed out', () => {
  it('carries the print id across to the site', () => {
    expect(destinationFor('/ibon_print/20260721_soda')).toBe('https://luma-studio.tw/ibon_print/20260721_soda')
  })

  it('sends everything else to the front page', () => {
    // The old host was an API. Its other paths mean something different on
    // the site, so following them would land on a 404 that looks like ours.
    expect(destinationFor('/api/print/20260721_soda')).toBe('https://luma-studio.tw')
    expect(destinationFor('/')).toBe('https://luma-studio.tw')
  })

  it('refuses to build a URL out of anything but an id', () => {
    expect(destinationFor('/ibon_print/../../etc')).toBe('https://luma-studio.tw')
    expect(destinationFor('/ibon_print/')).toBe('https://luma-studio.tw')
    expect(destinationFor('/ibon_print/https://evil.example')).toBe('https://luma-studio.tw')
  })

  it('redirects temporarily, so the day nobody holds the old link it can go', async () => {
    const response = await worker.fetch(new Request('https://luma-studio.infixman.workers.dev/ibon_print/abc'))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://luma-studio.tw/ibon_print/abc')
  })
})
