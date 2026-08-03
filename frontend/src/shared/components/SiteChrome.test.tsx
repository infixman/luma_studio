// @vitest-environment happy-dom

/**
 * The site header, and the one thing a signed-in member has to be able to find.
 *
 * Buying a course said "已開通" on the order and then offered nowhere to go:
 * `/account/courses` existed, was routed, and was linked to by nothing. The
 * account menu had 我的訂單 and 登出, so the only way to the thing just bought
 * was to know the URL.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { SiteHeader } from './SiteChrome'
import type { SiteSettings } from '../types'

const SETTINGS = {
  headerShowLogin: true,
  headerCtaLabel: '',
  headerCtaHref: '',
  logoPath: null,
  siteTitle: 'Luma Studio',
} as unknown as SiteSettings

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  scrollTo(0)
})

/** happy-dom has no layout, so the page never really moves. */
function scrollTo(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
  window.dispatchEvent(new Event('scroll'))
}

async function settle() {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function links(): string[] {
  return [...container.querySelectorAll('.account-popover a')].map(
    (link) => link.getAttribute('href') ?? '',
  )
}

test('a signed-in member is offered their courses as well as their orders', () => {
  render(<SiteHeader settings={SETTINGS} menu={[]} signedIn />, container)

  expect(links()).toContain('/account/courses')
  expect(links()).toContain('/orders')
})

test('a visitor who is not signed in is offered a way in instead', () => {
  /** No personal menu at all: the entries behind it are about somebody the
   *  site does not know yet. */
  render(<SiteHeader settings={SETTINGS} menu={[]} loginHref="/auth/login" />, container)

  expect(container.querySelector('.account-popover')).toBeNull()
  expect(container.textContent).toContain('登入')
})

/**
 * The header is a capsule floating clear of the page, and a capsule that
 * never reacts to being scrolled past is a capsule for no reason: the
 * inset is what makes it read as an object, and it has to give that inset
 * back once there is content underneath it to be shown.
 *
 * The class is the whole contract. What it does — height, width, shadow —
 * belongs to the stylesheet, and asserting on those here would only pin
 * down decisions the design is still free to change.
 */
function header(): HTMLElement | null {
  return container.querySelector('.site-header')
}

test('a header at rest is not wearing the scrolled state', async () => {
  render(<SiteHeader settings={{ ...SETTINGS, headerSticky: true }} menu={[]} />, container)
  await settle()

  expect(header()?.classList.contains('scrolled')).toBe(false)
})

test('the header notices the page has left the top', async () => {
  render(<SiteHeader settings={{ ...SETTINGS, headerSticky: true }} menu={[]} />, container)
  await settle()

  scrollTo(64)
  await settle()

  expect(header()?.classList.contains('scrolled')).toBe(true)
})

test('and notices coming back to it', async () => {
  /** Scrolling up to the top has to undo it. A one-way latch would leave
   *  the shrunk capsule sitting on an unscrolled page for the rest of the
   *  visit. */
  render(<SiteHeader settings={{ ...SETTINGS, headerSticky: true }} menu={[]} />, container)
  await settle()

  scrollTo(64)
  await settle()
  scrollTo(0)
  await settle()

  expect(header()?.classList.contains('scrolled')).toBe(false)
})

test('the mark is the only thing naming the way home', () => {
  /** The header wears the mark alone — no wordmark drawn into the picture,
   *  and no name in text beside it. That leaves the alt text carrying the
   *  whole job: it is the only thing telling a screen reader what this link
   *  is, and an empty one would announce it as nothing at all. */
  render(<SiteHeader settings={SETTINGS} menu={[]} />, container)

  const mark = container.querySelector('.brand img')
  expect(mark?.getAttribute('src')).toContain('mark')
  expect(mark?.getAttribute('alt')).toBe('苒光繪誌')
  expect(container.querySelector('.brand .brand-name')).toBeNull()
})

test('a colour the owner typed paints the capsule, not the strip it floats on', () => {
  /** The fixed palettes are class names and land wherever the stylesheet
   *  says. A custom colour is an inline style, and inline styles land on
   *  the element they are written on — which stopped being the thing that
   *  wears the colour the day the header became a capsule. Getting this
   *  wrong paints a band across the page and leaves the capsule white. */
  render(
    <SiteHeader
      settings={{
        ...SETTINGS,
        headerBackground: 'solid',
        headerColour: 'custom',
        headerCustomColour: '#123456',
      }}
      menu={[]}
    />,
    container,
  )

  const inner = container.querySelector<HTMLElement>('.header-inner')
  expect(inner?.style.backgroundColor).toBeTruthy()
  expect(container.querySelector<HTMLElement>('.site-header')?.style.backgroundColor).toBe('')
})

test('a header that scrolls away with the page never claims the state', async () => {
  /** Nothing is pinned, so there is no capsule left on screen to shrink —
   *  and the appearance preview in the back office renders exactly this
   *  header inside a panel the window scroll knows nothing about. */
  render(<SiteHeader settings={{ ...SETTINGS, headerSticky: false }} menu={[]} />, container)
  await settle()

  scrollTo(64)
  await settle()

  expect(header()?.classList.contains('scrolled')).toBe(false)
})

test('the back office preview never takes the scrolled state', async () => {
  /** The appearance preview renders this header inside a panel, and the
   *  window scroll it would otherwise listen to belongs to the admin page
   *  around it — so scrolling the settings form made the preview jump to
   *  its scrolled shape. Sticky is the owner's setting and has to keep
   *  meaning what it says on the real site, so the preview says so itself. */
  render(<SiteHeader settings={{ ...SETTINGS, headerSticky: true }} menu={[]} preview />, container)
  await settle()

  scrollTo(64)
  await settle()

  expect(header()?.classList.contains('scrolled')).toBe(false)
})
