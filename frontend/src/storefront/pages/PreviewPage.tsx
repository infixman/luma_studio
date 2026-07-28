import { useEffect, useState } from 'preact/hooks'

import { Blocks } from '../../shared/components/Blocks'
import { api } from '../../shared/api'
import type { PageContent } from '../../shared/types'
import '../styles/custom-page.css'

/**
 * One unpublished page, rendered by the storefront, for the editor to frame.
 *
 * It draws the blocks with the shop's own stylesheets on the shop's own
 * background, which the back office's inline preview cannot do — that one
 * renders them inside an admin panel.
 *
 * It does NOT wear the site header and footer, and that is deliberate. This
 * is the one path the site allows itself to be framed on, and the argument
 * for allowing that is that the page offers nothing worth tricking somebody
 * into clicking. The header carries a cart, a login link and the owner's own
 * call to action, so wearing it would make the argument false. `isBare` in
 * app.tsx is where that is enforced, and there is a test.
 *
 * So this is the content as the storefront draws it, not a photograph of the
 * published page. The chrome around it is the same on every page and can be
 * looked at on any of them.
 *
 * The token is spent by the request that reads it, so a reload is a dead link
 * on purpose — that is what stops a preview URL becoming a way to read drafts
 * later.
 */
export function PreviewPage({ token }: { token: string }) {
  const [page, setPage] = useState<PageContent | null>(null)
  const [failed, setFailed] = useState(false)

  // No ChromeControl: this route is bare, so there is no chrome to ask for.
  // The page's own showHeader/showFooter belong to it once it is published.
  useEffect(() => {
    api<PageContent>(`/api/pages/preview/${encodeURIComponent(token)}`)
      .then(setPage)
      .catch(() => setFailed(true))
  }, [token])

  if (failed) {
    return (
      <main class="custom-page">
        <p class="empty">預覽連結已經失效。回到編輯器再按一次預覽。</p>
      </main>
    )
  }
  if (page === null) return <main class="custom-page" />

  return (
    <main class="custom-page">
      <Blocks blocks={page.blocks} />
    </main>
  )
}
