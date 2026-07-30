/**
 * Where the admin API is, and what counts as a safe way to reach it.
 *
 * The tool sends a pairing code and then carries a bearer token on every
 * request. Over plain HTTP both are readable by anything between here and
 * there, so a wrong value in this one setting is not a misconfiguration — it is
 * the credential handed out.
 *
 * Which is why an override exists at all only for development, and why
 * localhost is the sole exception to requiring TLS: it does not leave the
 * machine.
 */

export const DEFAULT_ADMIN_API = 'https://admin-api.luma-studio.tw'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export class UnsafeEndpoint extends Error {}

/**
 * The base URL to use, or a refusal.
 *
 * Trailing slashes are removed so callers can join paths without thinking about
 * it — `${base}${path}` is the only form used, and a double slash is a 404 on
 * some routers and a redirect that drops the Authorization header on others.
 */
export function resolveAdminApi(override?: string | null): string {
  const raw = (override ?? '').trim() || DEFAULT_ADMIN_API

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeEndpoint(`管理後端網址無法解析：${raw}`)
  }

  const isLocal = LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    // Not a warning. Carrying on would send a token in the clear.
    throw new UnsafeEndpoint(`只接受 https（本機開發除外）：${raw}`)
  }
  if (url.username || url.password) {
    throw new UnsafeEndpoint('管理後端網址不能包含帳號密碼')
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}
