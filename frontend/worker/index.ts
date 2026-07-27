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
}

interface BioLink {
  displayName: string
  bio: string
  avatarPath: string | null
}

const BIO_LINK_PATH = '/bio_link'
const SITE_NAME = '苒光繪誌'
const PROFILE_CACHE_SECONDS = 300

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Collapses the bio to one line: a preview card cannot show line breaks. */
function oneLine(value: string, limit = 160): string {
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
function pageTitle(displayName: string): string {
  if (!displayName) return SITE_NAME
  return displayName.includes(SITE_NAME) ? displayName : `${displayName} | ${SITE_NAME}`
}

function previewTags(profile: BioLink, origin: string, apiBase: string): string {
  const title = pageTitle(profile.displayName)
  const description = oneLine(profile.bio) || `${SITE_NAME}的連結彙整`
  const image = profile.avatarPath ? `${apiBase}${profile.avatarPath}` : `${origin}/assets/luma-studio-logo.png`
  const url = `${origin}${BIO_LINK_PATH}`

  return [
    `<meta property="og:type" content="profile">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
    `<meta name="description" content="${escapeHtml(description)}">`,
  ].join('\n    ')
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
    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return asset

    const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
    // Anything but a served document here means the build is broken; passing
    // the response through would send the visitor somewhere unexpected.
    if (shell.status !== 200) return new Response('Not found', { status: 404 })

    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path !== BIO_LINK_PATH) return shellResponse(await shell.text(), shell)

    const profile = await loadBioLink(env)
    const html = await shell.text()
    if (!profile) return shellResponse(html, shell)

    const apiBase = env.API_BASE.replace(/\/+$/, '')
    // Some previewers ignore og:title and read <title>, so set both.
    const injected = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle(profile.displayName))}</title>`)
      .replace('</head>', `  ${previewTags(profile, url.origin, apiBase)}\n  </head>`)
    return shellResponse(injected, shell)
  },
}
