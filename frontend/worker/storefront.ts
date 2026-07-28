/**
 * Serves the built SPA, and gives its shareable pages real link-preview tags.
 *
 * A single-page app is empty HTML until its JavaScript runs, and the crawlers
 * behind LINE, Facebook and Slack previews do not run it. So every page that
 * gets sent to someone — the name card, a custom page, a product — is served
 * with its own title, description and image already in the markup.
 *
 * The lookup that fills those in is allowed to fail. A page with no preview
 * card is a missed opportunity; a page that does not load because the API was
 * slow is a broken link, and the second is far worse than the first.
 */

interface Env {
  ASSETS: Fetcher
  API_BASE: string
  ADMIN_ORIGIN: string
}

interface BioLink {
  displayName: string
  bio: string
  avatarPath: string | null
}

/** The share fields of the public page payload; the rest is for the app. */
interface PageContent {
  title: string
  shareDescription: string
  shareImagePath: string | null
}

interface ProductDetail {
  title: string
  description: string
  images: { path: string | null; alt: string }[]
}

// The public name-card page. Note its neighbour /cart is one letter away;
// both are live, so keep them straight when touching either.
const CARD_PATH = '/card'
const SHOP_PATH = '/shop'
// Category pages live under /shop/c/…, so this segment is never a product.
const CATEGORY_SEGMENT = 'c'
const SITE_NAME = '苒光繪誌'
const PREVIEW_CACHE_SECONDS = 300

// The branded landscape card, and the size it is. Preview cards crop to
// roughly 1.91:1, so this is the fallback whenever a page has no picture of
// its own — a card with the studio's name beats a card with a broken image.
const SHARE_CARD = '/assets/share-card.png'
const SHARE_CARD_SIZE = { width: 1200, height: 630 }

interface Preview {
  /** Both <title> and og:title: some previewers read only one of them. */
  title: string
  description: string
  /** Absolute — a crawler does not resolve a path against the page it read. */
  image: string
  imageAlt: string
  url: string
  type: 'profile' | 'website' | 'product'
  /** Stated only when we know it, which is when we shipped the image. */
  imageSize?: { width: number; height: number }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Collapses the bio to one line: a preview card cannot show line breaks. */
export function oneLine(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Avoids "… | 苒光繪誌 | 苒光繪誌" when the name already carries the studio. */
export function pageTitle(displayName: string): string {
  if (!displayName) return SITE_NAME
  return displayName.includes(SITE_NAME) ? displayName : `${displayName} | ${SITE_NAME}`
}

/**
 * Which public endpoint knows about this path, if any.
 *
 * Kept apart from the fetching so the routing can be read — and tested —
 * without a network. Null means the page is served untouched, which is the
 * answer for everything under /shop that is not one product: the index and
 * the category pages are the shop's own furniture, not a shared link.
 *
 * Paths that belong to no page at all still ask, and get a 404 back. The list
 * of reserved paths lives in the backend, and a second copy here would be the
 * copy nobody remembers to update.
 */
export function previewSource(path: string): string | null {
  if (path === CARD_PATH) return '/api/bio-link'
  // The most-shared URL of the lot, and it is an ordinary page underneath —
  // just one reached by a flag rather than by its path.
  if (path === '/') return '/api/pages/home'
  if (path.startsWith(`${SHOP_PATH}/`)) {
    const slug = path.slice(SHOP_PATH.length + 1)
    if (!slug || slug.includes('/') || slug === CATEGORY_SEGMENT) return null
    return `/api/products/${encodeURIComponent(slug)}`
  }
  // Only the shop itself, not everything spelled like it: /shopping-guide is
  // an ordinary page, and the backend says so too.
  if (path === SHOP_PATH) return null
  return `/api/pages?path=${encodeURIComponent(path)}`
}

async function loadJson<T>(env: Env, path: string): Promise<T | null> {
  try {
    const response = await fetch(`${env.API_BASE.replace(/\/+$/, '')}${path}`, {
      // Crawlers arrive in bursts when a link is shared; one API call per
      // burst is plenty, and a stale title for a few minutes is harmless.
      cf: { cacheTtl: PREVIEW_CACHE_SECONDS, cacheEverything: true },
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * A field of a payload, or empty.
 *
 * Everything the API sends is read as "maybe": a response that is not the
 * shape this Worker expected must cost a preview card, never the page it was
 * supposed to decorate.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Images are served by the API host, so their paths need its origin. */
function imageUrl(env: Env, path: string | null): string | null {
  if (!path) return null
  return `${env.API_BASE.replace(/\/+$/, '')}${path}`
}

export function cardPreview(profile: BioLink, origin: string): Preview {
  return {
    title: pageTitle(text(profile.displayName)),
    description: oneLine(text(profile.bio)) || `${SITE_NAME}的連結彙整`,
    image: `${origin}${SHARE_CARD}`,
    imageAlt: SITE_NAME,
    imageSize: SHARE_CARD_SIZE,
    url: `${origin}${CARD_PATH}`,
    type: 'profile',
  }
}

/**
 * A custom page's own card, falling back to the branded one.
 *
 * Nothing here is required of the owner: a page with an empty share panel
 * still gets its title and the studio's card, which is what it would have
 * shown anyway before any of this existed.
 */
export function pagePreview(page: PageContent, url: string, image: string | null): Preview {
  return {
    title: pageTitle(text(page.title)),
    description: oneLine(text(page.shareDescription)),
    image: image ?? `${new URL(url).origin}${SHARE_CARD}`,
    imageAlt: text(page.title) || SITE_NAME,
    imageSize: image ? undefined : SHARE_CARD_SIZE,
    url,
    type: 'website',
  }
}

/**
 * A product's card, built from what the shop already holds.
 *
 * The title and the cover photo are the product's own, so a product nobody
 * has written share text for still shares as itself rather than as the shop.
 */
export function productPreview(product: ProductDetail, url: string, cover: string | null): Preview {
  return {
    title: pageTitle(text(product.title)),
    description: oneLine(text(product.description)),
    image: cover ?? `${new URL(url).origin}${SHARE_CARD}`,
    imageAlt: text(product.images?.[0]?.alt) || text(product.title) || SITE_NAME,
    imageSize: cover ? undefined : SHARE_CARD_SIZE,
    url,
    type: 'product',
  }
}

export function previewTags(preview: Preview): string {
  const described = preview.description
    ? [
        `<meta property="og:description" content="${escapeHtml(preview.description)}">`,
        `<meta name="twitter:description" content="${escapeHtml(preview.description)}">`,
        `<meta name="description" content="${escapeHtml(preview.description)}">`,
      ]
    : []

  return [
    `<meta property="og:type" content="${preview.type}">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:title" content="${escapeHtml(preview.title)}">`,
    `<meta property="og:image" content="${escapeHtml(preview.image)}">`,
    `<meta property="og:image:alt" content="${escapeHtml(preview.imageAlt)}">`,
    // Stated so a crawler can lay out the card before it fetches the image.
    ...(preview.imageSize
      ? [
          `<meta property="og:image:width" content="${preview.imageSize.width}">`,
          `<meta property="og:image:height" content="${preview.imageSize.height}">`,
        ]
      : []),
    `<meta property="og:url" content="${escapeHtml(preview.url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(preview.title)}">`,
    `<meta name="twitter:image" content="${escapeHtml(preview.image)}">`,
    ...described,
  ].join('\n    ')
}

/** Some previewers ignore og:title and read <title>, so set both. */
export function inject(html: string, preview: Preview): string {
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(preview.title)}</title>`)
    .replace('</head>', `  ${previewTags(preview)}\n  </head>`)
}

/**
 * Whether this request is a link previewer rather than a person.
 *
 * Only previewers need the preview injected into the HTML — a browser runs
 * the app and fetches it anyway — and fetching it costs a round trip to the
 * API before a single byte reaches the visitor. So the wait is spent only on
 * requests that cannot do without it.
 *
 * The list errs towards matching: a browser wrongly treated as a crawler is
 * a slow page, but a crawler wrongly treated as a browser is a shared link
 * with no preview card. None of these substrings appear in the user agents
 * of Safari, Chrome, Firefox, or the in-app browsers of LINE and Instagram.
 */
export function isLinkPreviewer(userAgent: string): boolean {
  return /bot\b|bot\/|crawler|spider|facebookexternalhit|slack|discord|whatsapp|telegram|twitter|linkedin|pinterest|embedly|quora|skype|vkshare|preview|snapchat|line-?poker|yeti|naver|daum|petal|yandex|curl|wget/i.test(
    userAgent,
  )
}

/**
 * The back office moved to its own hostname, so its old URLs are forwarded.
 *
 * Permanent rather than temporary: these paths are not coming back, and the
 * owner's bookmarks and browser history should learn the new address rather
 * than route through here forever. The /admin segment is dropped because
 * every path on the admin host is administration — /admin/bio-link becomes
 * /bio-link.
 */
function adminRedirect(path: string, env: Env): Response | null {
  if (path !== '/admin' && !path.startsWith('/admin/')) return null
  const rest = path.slice('/admin'.length) || '/'
  return Response.redirect(`${env.ADMIN_ORIGIN.replace(/\/+$/, '')}${rest}`, 301)
}

/**
 * The one path this site allows itself to be framed on.
 *
 * It has to be applied here rather than in `_headers`, and that is the whole
 * reason this function takes a path. Every SPA route is served by fetching
 * `/index.html` — so the headers that come back are the ones matched against
 * `/index.html`, which is the `/*` block, whatever a more specific rule in
 * `_headers` says about `/__preview/*`. The rule was written and never fired.
 */
function framingFor(path: string, env: Env): { xfo: boolean; ancestors: string } {
  if (!path.startsWith('/__preview/')) return { xfo: true, ancestors: "'none'" }
  return { xfo: false, ancestors: env.ADMIN_ORIGIN.replace(/\/+$/, '') }
}

/** The shell is served for any unknown path, so the SPA can route it. */
function shellResponse(html: string, source: Response, path: string, env: Env): Response {
  const headers = new Headers(source.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.delete('content-length')
  headers.delete('etag')

  const framing = framingFor(path, env)
  // X-Frame-Options cannot name another host — its allow-list stops at
  // SAMEORIGIN — so on the preview path it is removed and the CSP does the
  // work. Everywhere else it stays, and says DENY.
  if (framing.xfo) headers.set('x-frame-options', 'DENY')
  else headers.delete('x-frame-options')

  const policy = headers.get('content-security-policy')
  if (policy) {
    headers.set(
      'content-security-policy',
      policy.replace(/frame-ancestors[^;]*/, `frame-ancestors ${framing.ancestors}`),
    )
  }
  return new Response(html, { status: 200, headers })
}

/**
 * The card for this path, or null when there is nothing to say about it.
 *
 * Every branch treats a missing answer as "no preview" rather than as an
 * error, so a page whose metadata could not be fetched is still a page.
 */
async function previewFor(path: string, url: URL, env: Env): Promise<Preview | null> {
  const source = previewSource(path)
  if (source === null) return null
  const address = `${url.origin}${path}`

  if (path === CARD_PATH) {
    const profile = await loadJson<BioLink>(env, source)
    return profile && cardPreview(profile, url.origin)
  }

  if (source.startsWith('/api/products/')) {
    const product = await loadJson<ProductDetail>(env, source)
    if (!product || !text(product.title)) return null
    return productPreview(product, address, imageUrl(env, product.images?.[0]?.path ?? null))
  }

  const page = await loadJson<PageContent>(env, source)
  // No title means this is not a page we asked for — a 404 body, or an
  // answer from a version of the API that predates any of this.
  if (!page || !text(page.title)) return null
  return pagePreview(page, address, imageUrl(env, page.shareImagePath))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const moved = adminRedirect(url.pathname.replace(/\/+$/, '') || '/', env)
    if (moved) return moved

    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return asset

    const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
    // Anything but a served document here means the build is broken; passing
    // the response through would send the visitor somewhere unexpected.
    if (shell.status !== 200) return new Response('Not found', { status: 404 })

    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (!isLinkPreviewer(request.headers.get('user-agent') ?? '')) {
      return shellResponse(await shell.text(), shell, path, env)
    }

    const preview = await previewFor(path, url, env)
    const html = await shell.text()
    if (!preview) return shellResponse(html, shell, path, env)
    return shellResponse(inject(html, preview), shell, path, env)
  },
}
