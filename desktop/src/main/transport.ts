import type { HttpResponse, Transport } from '../shared/adminApi'

/**
 * How the main process talks to the admin API.
 *
 * One adapter rather than one per caller. `fetch`'s Response is structurally the
 * `HttpResponse` the shared layer takes, so the cast is the whole of it — and
 * three copies of a one-line cast is three places to differ about timeouts,
 * headers or error handling the day any of those stops being nothing.
 */
export const transport: Transport = (url, init) => fetch(url, init) as Promise<HttpResponse>
