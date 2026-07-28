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
 * `bare` is for checkout and the order pages. A row of navigation links part
 * way through paying is an invitation to go and look at something else.
 */
export function Chrome({ bare, children }: { bare?: boolean; children: ComponentChildren }) {
  const [chrome, setChrome] = useState<SiteChrome | null>(null)
  const [items, setItems] = useState(0)

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

  if (bare || chrome === null) return <>{children}</>

  return (
    <>
      <SiteHeader
        settings={chrome.settings}
        menu={chrome.menu}
        cartCount={items}
        loginHref={loginUrl(`${location.origin}/orders`)}
      />
      {children}
      <SiteFooter settings={chrome.settings} />
    </>
  )
}
