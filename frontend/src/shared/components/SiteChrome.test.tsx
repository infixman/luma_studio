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
})

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
