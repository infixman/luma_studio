/**
 * Serves the built back office.
 *
 * Nothing here is shared with the world, so there is none of the storefront's
 * link-preview machinery: no crawler ever sees these pages, and every one of
 * them sits behind a Google sign-in. What is left is the one thing the asset
 * router cannot do on its own — hand the SPA shell to a client-side route
 * rather than answering it with a redirect to the home page.
 */

interface Env {
  ASSETS: Fetcher
}

/**
 * Vite names an emitted HTML file after its source, so this build's shell is
 * admin.html rather than index.html. Renaming it would mean a post-build step
 * or a second Vite root, neither of which is worth it to make one constant
 * read the way you expect.
 */
const SHELL = '/admin.html'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return asset

    const shell = await env.ASSETS.fetch(new Request(new URL(SHELL, request.url), request))
    // Anything but a served document means the build is broken. Passing the
    // response through would send the visitor somewhere unexpected.
    if (shell.status !== 200) return new Response('Not found', { status: 404 })

    const headers = new Headers(shell.headers)
    headers.set('content-type', 'text/html; charset=utf-8')
    headers.delete('content-length')
    headers.delete('etag')
    return new Response(await shell.text(), { status: 200, headers })
  },
}
