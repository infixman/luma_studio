import { useEffect, useState } from 'preact/hooks'

import { routeForPath } from '../routes'

/**
 * Moving between back-office pages without fetching the document again.
 *
 * Every link in here was an ordinary `<a href>` and every jump was
 * `location.assign`, so each one threw the running application away and built
 * a new one: parse, boot, and — because `AdminGate` mounts with it — another
 * round trip to `/api/session` before a single pixel of the next page. What
 * that looked like was the mark on an empty page, on every click.
 *
 * The gate is the reason this is worth doing rather than merely nice. It is
 * correct for it to block: nothing of the back office should be drawn for
 * somebody we have not identified. It is only wrong to make it do that again
 * for a visitor it identified four seconds ago.
 */

const listeners = new Set<() => void>()

export function currentPath(): string {
  return location.pathname.replace(/\/+$/, '') || '/'
}

export function navigate(path: string): void {
  // The sidebar offers the page you are on. Pushing it would turn Back into a
  // key that appears to do nothing.
  if (path === location.pathname + location.search) return
  history.pushState(null, '', path)
  for (const listener of listeners) listener()
}

/**
 * Whether this click is ours, and where it wants to go.
 *
 * Everything it declines stays a real navigation, which is the safe default:
 * a link this does not understand still works, it is just slower. A link it
 * wrongly claims is a link that stops working.
 */
export function destinationOf(event: MouseEvent): string | null {
  // Somebody nearer the element has already decided what this click means.
  if (event.defaultPrevented) return null
  // Anything but a plain left button means "open this somewhere else".
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null

  const anchor = (event.target as Element | null)?.closest?.('a')
  if (!anchor) return null
  // Both are instructions to the browser about what to do with the file at
  // the other end, and neither is "replace what is on screen".
  if (anchor.getAttribute('target') || anchor.hasAttribute('download')) return null

  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('#')) return null

  // Resolves relative hrefs, and settles mailto: and tel: by their origin.
  const url = new URL(href, location.href)
  if (url.origin !== location.origin) return null

  // The routing table is the whole definition of what the back office owns.
  // /auth/logout has to reach the server; the storefront is another
  // application; an unknown path deserves the server's own answer.
  if (!routeForPath(url.pathname)) return null

  return url.pathname + url.search
}

/** The current path, re-rendering the caller whenever it changes. */
export function useRoute(): string {
  const [path, setPath] = useState(currentPath())

  useEffect(() => {
    const sync = () => setPath(currentPath())
    listeners.add(sync)
    addEventListener('popstate', sync)
    return () => {
      listeners.delete(sync)
      removeEventListener('popstate', sync)
    }
  }, [])

  return path
}

/**
 * Takes over in-app links for as long as the application is mounted.
 *
 * One listener on the document rather than an onClick on every link: the
 * links are in twenty components, several of them inside tables that build
 * their cells from a column definition, and a rule that has to be remembered
 * at each of those places is a rule that will be missed at the next one.
 */
export function interceptLinks(): () => void {
  const onClick = (event: MouseEvent) => {
    const destination = destinationOf(event)
    if (!destination) return
    event.preventDefault()
    navigate(destination)
  }

  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
