/**
 * Serves the built SPA, and gives the bio link page real link-preview tags.
 *
 * A single-page app is empty HTML until its JavaScript runs, and the crawlers
 * behind LINE, Facebook and Slack previews do not run it. Since a bio link
 * exists to be shared, its page is rendered with the profile's own title,
 * description and image already in the markup.
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

const BIO_LINK_PATH = '/bio_link'
const SITE_NAME = '苒光繪誌'
const PROFILE_CACHE_SECONDS = 300

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

async function loadBioLink(env: Env): Promise<BioLink | null> {
  try {
    const response = await fetch(`${env.API_BASE}/api/bio-link`, {
      // Crawlers arrive in bursts when a link is shared; one API call per
      // burst is plenty, and a stale title for a few minutes is harmless.
      cf: { cacheTtl: PROFILE_CACHE_SECONDS, cacheEverything: true },
    })
    if (!response.ok) return null
    return (await response.json()) as BioLink
  } catch {
    return null
  }
}

/** Avoids "… | 苒光繪誌 | 苒光繪誌" when the name already carries the studio. */
export function pageTitle(displayName: string): string {
  if (!displayName) return SITE_NAME
  return displayName.includes(SITE_NAME) ? displayName : `${displayName} | ${SITE_NAME}`
}

function previewTags(profile: BioLink, origin: string): string {
  const title = pageTitle(profile.displayName)
  const description = oneLine(profile.bio) || `${SITE_NAME}的連結彙整`
  // The branded landscape card rather than the avatar: preview cards crop to
  // roughly 1.91:1, which turns a square portrait into a slice of a face.
  const image = `${origin}/assets/share-card.png`
  const url = `${origin}${BIO_LINK_PATH}`

  return [
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:image:alt" content="${escapeHtml(SITE_NAME)}">`,
    // Stated so a crawler can lay out the card before it fetches the image.
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
    `<meta name="description" content="${escapeHtml(description)}">`,
  ].join('\n    ')
}

/**
 * Whether this request is a link previewer rather than a person.
 *
 * Only previewers need the profile injected into the HTML — a browser runs
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

/** The shell is served for any unknown path, so the SPA can route it. */
function shellResponse(html: string, source: Response): Response {
  const headers = new Headers(source.headers)
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.delete('content-length')
  headers.delete('etag')
  return new Response(html, { status: 200, headers })
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
    if (path !== BIO_LINK_PATH) return shellResponse(await shell.text(), shell)
    if (!isLinkPreviewer(request.headers.get('user-agent') ?? '')) {
      return shellResponse(await shell.text(), shell)
    }

    const profile = await loadBioLink(env)
    const html = await shell.text()
    if (!profile) return shellResponse(html, shell)

    // Some previewers ignore og:title and read <title>, so set both.
    const injected = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle(profile.displayName))}</title>`)
      .replace('</head>', `  ${previewTags(profile, url.origin)}\n  </head>`)
    return shellResponse(injected, shell)
  },
}
