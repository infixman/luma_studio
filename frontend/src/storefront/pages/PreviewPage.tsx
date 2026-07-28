import { useContext, useEffect, useState } from 'preact/hooks'

import { Blocks } from '../../shared/components/Blocks'
import { ChromeControl } from '../components/Chrome'
import { api } from '../../shared/api'
import type { PageContent } from '../../shared/types'
import '../styles/custom-page.css'

/**
 * One unpublished page, shown inside the real site, for the editor to frame.
 *
 * The back office can already render blocks — it uses these same components —
 * but not inside the header, the footer and the background they will actually
 * sit in. That gap is the whole reason this route exists: the only way to see
 * the storefront is to be the storefront.
 *
 * The token is spent by the request that reads it, so a reload is a dead
 * link on purpose. That is what keeps a preview URL from becoming a way to
 * read drafts later.
 *
 * This route renders and nothing else. No cart, no checkout, no session, no
 * link that leaves it — because it is the one path the site allows itself to
 * be framed on, and a page that can be framed should have nothing worth
 * tricking somebody into clicking.
 */
export function PreviewPage({ token }: { token: string }) {
  const [page, setPage] = useState<PageContent | null>(null)
  const [failed, setFailed] = useState(false)
  const setChrome = useContext(ChromeControl)

  useEffect(() => {
    api<PageContent>(`/api/pages/preview/${encodeURIComponent(token)}`)
      .then((data) => {
        setPage(data)
        setChrome({ header: data.showHeader, footer: data.showFooter })
      })
      .catch(() => setFailed(true))
  }, [token, setChrome])

  useEffect(() => () => setChrome({ header: true, footer: true }), [setChrome])

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
