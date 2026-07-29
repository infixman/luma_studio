import { useContext, useEffect, useState } from 'preact/hooks'

import { Blocks } from '../../shared/components/Blocks'
import { ChromeControl } from '../components/Chrome'
import { ApiError, api } from '../../shared/api'
import type { PageContent } from '../../shared/types'
import '../styles/custom-page.css'

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'page'; page: PageContent }

/**
 * A page the owner built in the back office.
 *
 * `onMissing` lets the router say so in its own words — "no such page" for an
 * unknown path, "the home page has not been built yet" for `/`. Neither is a
 * second copy of a page: the front door is this component and nothing else.
 */
export function CustomPage({ path, onMissing }: { path: string; onMissing: () => preact.JSX.Element }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const setChrome = useContext(ChromeControl)

  useEffect(() => {
    const url = path === '/' ? '/api/pages/home' : `/api/pages?path=${encodeURIComponent(path)}`
    api<PageContent>(url)
      .then((page) => {
        setState({ kind: 'page', page })
        // The back office calls this field the browser tab's title, so it
        // has to actually become one.
        document.title = `${page.title} | Luma Studio`
        // Only a page that loaded may turn the chrome off. A failed fetch
        // leaves the header alone rather than stripping it.
        setChrome({ header: page.showHeader, footer: page.showFooter })
      })
      .catch((error) => setState(error instanceof ApiError && error.status === 404 ? { kind: 'missing' } : { kind: 'failed' }))
  }, [path, setChrome])

  // Whatever this page asked for is undone when the visitor leaves it.
  useEffect(() => () => setChrome({ header: true, footer: true }), [setChrome])

  // Nothing is drawn while the answer is unknown. Showing "not found" first
  // and replacing it a moment later reads as a broken link that healed.
  if (state.kind === 'loading') return (
    <main class="custom-page">
      <div class="skeleton" style={{ height: '1.2rem', width: '40%', marginBottom: '1rem' }} />
      <div class="skeleton" style={{ height: '0.9rem', width: '100%', marginBottom: '0.6rem' }} />
      <div class="skeleton" style={{ height: '0.9rem', width: '90%', marginBottom: '0.6rem' }} />
      <div class="skeleton" style={{ height: '0.9rem', width: '75%', marginBottom: '2rem' }} />
      <div class="skeleton" style={{ height: '14rem', width: '100%' }} />
    </main>
  )
  if (state.kind === 'missing') return onMissing()
  if (state.kind === 'failed') return <main class="custom-page"><p class="empty">頁面載入失敗，請稍後再試一次。</p></main>

  return (
    <main class="custom-page">
      <Blocks blocks={state.page.blocks} />
    </main>
  )
}
