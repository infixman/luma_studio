/**
 * Keeps one handed-out URL alive.
 *
 * `https://luma-studio.infixman.workers.dev/ibon_print/{id}` was printed and
 * shared before the site had its own domain. A workers.dev hostname is the
 * Worker's name, so that address exists only while a Worker called
 * `luma-studio` does — which is why this tiny thing keeps the name after the
 * public API moved to `luma-studio-web-api`.
 *
 * It holds nothing: no database, no bucket, no secrets, and no cron. That is
 * the point. Two Workers with the same schedule would sweep expired orders and
 * drain the mail queue twice.
 *
 * 302 rather than 301. The redirect is meant to be temporary — until nobody
 * is holding a piece of paper with the old address on it — and a 301 is
 * cached by browsers long after anyone can change their mind.
 */

const SITE = 'https://luma-studio.tw'

// The one path worth carrying across. Anything else on the old host was an
// API endpoint whose path means something different on the site, so sending
// it to the matching page would land on a 404 that looks like our fault.
const PRINT_PREFIX = '/ibon_print/'
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/

export function destinationFor(pathname: string): string {
  if (pathname.startsWith(PRINT_PREFIX)) {
    const identifier = pathname.slice(PRINT_PREFIX.length)
    if (IDENTIFIER.test(identifier)) return `${SITE}${PRINT_PREFIX}${identifier}`
  }
  return SITE
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    return Response.redirect(destinationFor(pathname), 302)
  },
}
