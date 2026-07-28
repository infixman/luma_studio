import { createContext } from 'preact'
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

import { SiteFooter, SiteHeader } from '../../shared/components/SiteChrome'
import { api, loginUrl } from '../../shared/api'
import type { SiteChrome } from '../../shared/types'
import * as cart from '../lib/cart'

/**
 * Wraps a storefront page in the site's header and footer.
 *
 * The chrome is fetched once per page load. Until it arrives the page renders
 * without it rather than behind a spinner: the content is what the visitor
 * came for, and holding it back for a navigation bar is the wrong trade.
 *
 * `bare` is for checkout, and for the pages that stand on their own — the
 * name card, the ibon printout, the draft preview. A row of navigation links
 * part way through paying is an invitation to go and look at something else;
 * the others have their own reasons, and `isBare` in app.tsx holds all of
 * them with a test. The order pages are NOT among them: looking up a past
 * order is browsing, and this said otherwise long after that changed.
 *
 * A custom page may also turn either half off for itself. It is the page that
 * knows, and the page renders inside this, so it says so through
 * `ChromeControl` rather than being fetched a second time out here.
 */

export type ChromeWanted = { header: boolean; footer: boolean }

export const ChromeControl = createContext<(wanted: ChromeWanted) => void>(() => undefined)
export function Chrome({ bare, children }: { bare?: boolean; children: ComponentChildren }) {
  const [chrome, setChrome] = useState<SiteChrome | null>(null)
  const [items, setItems] = useState(0)
  const [wanted, setWanted] = useState<ChromeWanted>({ header: true, footer: true })

  useEffect(() => {
    if (bare) return
    // A failure here is silent. No header is a worse page; no page is worse
    // than that.
    api<SiteChrome>('/api/site')
      .then(setChrome)
      .catch(() => undefined)
  }, [bare])

  useEffect(() => {
    const refresh = () => setItems(cart.count())
    refresh()
    return cart.onChange(refresh)
  }, [])

  if (bare || chrome === null) return <ChromeControl.Provider value={setWanted}>{children}</ChromeControl.Provider>

  return (
    <ChromeControl.Provider value={setWanted}>
      {wanted.header && (
        <SiteHeader
          settings={chrome.settings}
          menu={chrome.menu}
          cartCount={items}
          loginHref={loginUrl(`${location.origin}/orders`)}
        />
      )}
      {children}
      {wanted.footer && <SiteFooter settings={chrome.settings} />}
    </ChromeControl.Provider>
  )
}
