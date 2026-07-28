import { useEffect, useState } from 'preact/hooks'

import { Blocks } from '../../shared/components/Blocks'
import { ApiError, api } from '../../shared/api'
import type { PageContent } from '../../shared/types'
import '../styles/custom-page.css'

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'page'; page: PageContent }

/**
 * A page the owner built in the back office.
 *
 * `onMissing` lets the router fall back — for an unknown path that means the
 * built-in "no such page" message, and for `/` it means the hard-coded home
 * page, so shipping this does not blank the front door before anyone has
 * flagged a page as home.
 */
export function CustomPage({ path, onMissing }: { path: string; onMissing: () => preact.JSX.Element }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    const url = path === '/' ? '/api/pages/home' : `/api/pages?path=${encodeURIComponent(path)}`
    api<PageContent>(url)
      .then((page) => {
        setState({ kind: 'page', page })
        // The back office calls this field the browser tab's title, so it
        // has to actually become one.
        document.title = `${page.title} | Luma Studio`
      })
      .catch((error) => setState(error instanceof ApiError && error.status === 404 ? { kind: 'missing' } : { kind: 'failed' }))
  }, [path])

  // Nothing is drawn while the answer is unknown. Showing "not found" first
  // and replacing it a moment later reads as a broken link that healed.
  if (state.kind === 'loading') return <main class="custom-page" />
  if (state.kind === 'missing') return onMissing()
  if (state.kind === 'failed') return <main class="custom-page"><p class="empty">頁面載入失敗，請稍後再試一次。</p></main>

  return (
    <main class="custom-page">
      <Blocks blocks={state.page.blocks} />
    </main>
  )
}
