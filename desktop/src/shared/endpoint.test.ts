import { describe, expect, test } from 'vitest'

import { DEFAULT_ADMIN_API, UnsafeEndpoint, resolveAdminApi } from './endpoint'

describe('where the tool sends its credentials', () => {
  test('with no override it is the production API', () => {
    expect(resolveAdminApi()).toBe(DEFAULT_ADMIN_API)
  })

  test('an empty override is the same as none', () => {
    expect(resolveAdminApi('   ')).toBe(DEFAULT_ADMIN_API)
  })

  test('https anywhere is fine', () => {
    expect(resolveAdminApi('https://staging.example.com')).toBe('https://staging.example.com')
  })

  test.each(['http://localhost:8787', 'http://127.0.0.1:8787'])(
    'plain http is allowed for %s, because it does not leave the machine',
    (value) => {
      expect(resolveAdminApi(value)).toBe(value)
    },
  )

  test('plain http anywhere else is refused', () => {
    /** Not a warning. The tool sends a pairing code and then a bearer token on
     *  every request, so carrying on would hand both to anything in between. */
    expect(() => resolveAdminApi('http://admin-api.luma-studio.tw')).toThrow(UnsafeEndpoint)
  })

  test('a hostname that merely contains localhost is refused', () => {
    expect(() => resolveAdminApi('http://localhost.evil.example')).toThrow(UnsafeEndpoint)
  })

  test('credentials embedded in the URL are refused', () => {
    /** They would end up in whatever logs the request, and they are never
     *  something this tool needs. */
    expect(() => resolveAdminApi('https://user:pass@example.com')).toThrow(UnsafeEndpoint)
  })

  test('something that is not a URL is refused', () => {
    expect(() => resolveAdminApi('admin-api.luma-studio.tw')).toThrow(UnsafeEndpoint)
  })

  test('a trailing slash is removed so paths can be joined without care', () => {
    /** `${base}${path}` is the only form used, and a double slash is a 404 on
     *  some routers and a redirect that drops the Authorization header on
     *  others. */
    expect(resolveAdminApi('https://example.com/')).toBe('https://example.com')
    expect(resolveAdminApi('https://example.com///')).toBe('https://example.com')
  })

  test('a path prefix is kept, because a reverse proxy may add one', () => {
    expect(resolveAdminApi('https://example.com/admin/')).toBe('https://example.com/admin')
  })
})
