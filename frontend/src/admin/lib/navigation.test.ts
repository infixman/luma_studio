// @vitest-environment happy-dom

/**
 * Which clicks the back office takes over, and which it leaves to the browser.
 *
 * The rule is one-directional: anything not understood stays a real
 * navigation. A link this declines still works, it is only slower — whereas a
 * link it wrongly claims is a link that stops working, and the ways to be
 * wrong here are all ordinary things people do to links. Opening one in a new
 * tab, saving a download, following a sign-out that has to reach the server.
 */

import { afterEach, beforeEach, expect, test } from 'vitest'

import { destinationOf, interceptLinks, navigate, currentPath } from './navigation'

let root: HTMLDivElement

beforeEach(() => {
  history.replaceState(null, '', '/courses')
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  root.remove()
})

/**
 * Where a click on a freshly built link would take the back office.
 *
 * `destinationOf` is asked from inside a listener, which is both where
 * production asks it and the only place it can be asked here: happy-dom
 * follows an un-cancelled link during `dispatchEvent`, so reading the answer
 * afterwards reads it against a document that has already moved — and a link
 * to another origin then looks like a link to this one.
 *
 * @param nested render the link with something inside it and click that
 *   instead, the way a row does when it puts a badge in the cell
 * @param before runs first, for the click somebody else has already claimed
 */
function destinationFor(
  attributes: Record<string, string>,
  init: MouseEventInit = {},
  { nested = false, before }: { nested?: boolean; before?: (event: MouseEvent) => void } = {},
): string | null {
  const anchor = document.createElement('a')
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value)
  const inner = document.createElement('span')
  inner.textContent = 'link'
  anchor.append(inner)
  root.append(anchor)

  let seen: string | null = null
  const claim = (event: Event) => before?.(event as MouseEvent)
  const ask = (event: Event) => {
    seen = destinationOf(event as MouseEvent)
    // Whatever the answer, the document must not wander off to the next test.
    event.preventDefault()
  }

  anchor.addEventListener('click', claim)
  document.addEventListener('click', ask)
  const target = nested ? inner : anchor
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
  document.removeEventListener('click', ask)

  return seen
}

test('an ordinary click on a page of the back office is ours', () => {
  expect(destinationFor({ href: '/orders' })).toBe('/orders')
})

test('a link to a record is ours too', () => {
  /** These carry an id the routing table only knows by pattern; a router that
   *  handled the list pages and not the detail pages would reload on every
   *  row anybody opened. */
  expect(destinationFor({ href: '/courses/abc123' })).toBe('/courses/abc123')
})

test('a click on something inside the link still counts', () => {
  /** Rows put a badge or an icon in the link, and the event target is
   *  whatever was under the pointer. */
  expect(destinationFor({ href: '/videos' }, {}, { nested: true })).toBe('/videos')
})

test('a middle click is not ours', () => {
  expect(destinationFor({ href: '/orders' }, { button: 1 })).toBeNull()
})

test('a click held with a modifier is not ours', () => {
  /** Every one of these means "open this somewhere else", and answering by
   *  quietly replacing the current page instead is the rudest thing a router
   *  can do. */
  for (const held of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
    expect(destinationFor({ href: '/orders' }, { [held]: true })).toBeNull()
  }
})

test('a link aimed at another tab is not ours', () => {
  expect(destinationFor({ href: '/orders', target: '_blank' })).toBeNull()
})

test('a download is not ours', () => {
  expect(destinationFor({ href: '/orders', download: 'orders.csv' })).toBeNull()
})

test('a link to somewhere else entirely is not ours', () => {
  expect(destinationFor({ href: 'https://luma-studio.tw/' })).toBeNull()
})

test('a path that is not a page of the back office is not ours', () => {
  /** Signing out has to reach the server, and the storefront is a different
   *  application on a different host's terms. The routing table is the whole
   *  definition of what this owns. */
  expect(destinationFor({ href: '/auth/logout' })).toBeNull()
})

test('a jump within the page is not ours', () => {
  expect(destinationFor({ href: '#main' })).toBeNull()
})

test('a click something else already handled is not ours', () => {
  expect(destinationFor({ href: '/orders' }, {}, { before: (event) => event.preventDefault() })).toBeNull()
})

/**
 * The whole point, stated as the browser sees it.
 *
 * An un-cancelled click on a link fetches the document again, and fetching
 * the document again is what put the mark on an empty page between every two
 * screens of the back office: a new application, a new AdminGate, another
 * round trip to /api/session before anything could be drawn.
 */
function clickThrough(href: string): { event: MouseEvent; landed: string } {
  const stop = interceptLinks()
  const anchor = document.createElement('a')
  anchor.setAttribute('href', href)
  root.append(anchor)

  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  anchor.dispatchEvent(event)
  stop()

  return { event, landed: currentPath() }
}

test('a link to another page never reaches the browser', () => {
  const { event, landed } = clickThrough('/orders')

  expect(event.defaultPrevented).toBe(true)
  expect(landed).toBe('/orders')
})

test('signing out still does', () => {
  /** It has to clear the cookie on the server, and the gate has to run again
   *  afterwards. This is the one navigation that should cost a document. */
  const { event } = clickThrough('/auth/logout')

  expect(event.defaultPrevented).toBe(false)
})

test('navigating changes the path without leaving the document', () => {
  navigate('/storage')

  expect(currentPath()).toBe('/storage')
  expect(location.pathname).toBe('/storage')
})

test('navigating to where we already are does not stack up history', () => {
  /** Otherwise the current page's own link in the sidebar becomes a way to
   *  make Back stop working. */
  const before = history.length
  navigate('/courses')

  expect(history.length).toBe(before)
})
