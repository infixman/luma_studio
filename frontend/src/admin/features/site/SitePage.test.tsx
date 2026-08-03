// @vitest-environment happy-dom

/**
 * Header and footer settings.
 *
 * The last big page still built out of raw `<label><input>`, bare `<select>`
 * and `<button class="danger">`. Every other page in the back office draws
 * with the component set, which is why this one looked like a different
 * product: its labels sat at a different size, its selects rendered with the
 * operating system, and its "add one" buttons hung off the bottom of each
 * list instead of sitting at the top of the block they add to.
 *
 * What is pinned here is the contract, not the pixels: nothing raw left in
 * the forms, adds at the top of their own section, and deletes behind the
 * row's own menu.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { MenuState, SiteSettings } from '../../../shared/types'

const SETTINGS: SiteSettings = {
  headerBackground: 'solid',
  headerColour: 'cream',
  headerCustomColour: '#ffffff',
  headerImagePath: null,
  headerHeight: 'medium',
  headerText: 'dark',
  headerCustomText: '#2b2622',
  headerLogoSize: 'medium',
  headerSticky: true,
  headerShowCart: true,
  headerShowLogin: true,
  headerCtaLabel: '',
  headerCtaUrl: '',
  footerColour: 'ink',
  footerText: 'light',
  footerCustomColour: '#2b2622',
  footerCustomText: '#f3efe9',
  footerBlurb: '台中的插畫工作室',
  footerCopyright: '© 2026 苒光繪誌',
  footerColumns: [{ title: '服務', links: [{ label: '退換貨', url: 'https://x.test', newTab: true }] }],
  footerSocials: [{ platform: 'instagram', url: 'https://ig.test', newTab: true }],
}

const MENU: MenuState = {
  menu: [{ id: 'm1', parentId: null, label: '關於', targetKind: 'page', target: 'p1', position: 0 }],
  pages: [{ id: 'p1', title: '關於苒光', path: '/about', status: 'published' }],
  categories: [{ slug: 'prints', title: '版畫' }],
}

vi.mock('../../../shared/api', () => ({
  api: vi.fn(async (url: string) => {
    if (url === '/api/menu') return MENU
    return { settings: SETTINGS }
  }),
  apiJson: vi.fn(async () => MENU),
  apiUrl: (path: string) => path,
  uploadHeaderImage: vi.fn(async () => ({ settings: SETTINGS })),
}))

vi.mock('../../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { SitePage } from './SitePage'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The loading state is a Panel too, so waiting for one is not waiting for
 *  the page — wait for a panel that has a title, which only the loaded page
 *  renders. */
async function settle() {
  for (let i = 0; i < 40; i++) {
    if (container.querySelector('.ui-panel-title')) return
    await tick()
  }
}

function panel(title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.ui-panel')].find(
    (p) => p.querySelector('.ui-panel-title')?.textContent === title,
  )
}

function section(title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.ui-section')].find(
    (s) => s.querySelector('.ui-subhead')?.textContent === title,
  )
}

test('the forms are drawn with the component set, not with raw markup', async () => {
  /** A bare <select> renders with the operating system, so this page looked
   *  like Windows while everything beside it looked like the back office. */
  render(<SitePage />, container)
  await settle()

  expect(container.querySelector('.ui-panel-body select')).toBeNull()
  expect(container.querySelector('.ui-panel-body button.danger')).toBeNull()

  // Every text input belongs to a Field, which is what carries the label.
  const loose = [...container.querySelectorAll('.ui-panel-body input')].filter(
    (input) =>
      !input.closest('.ui-field') &&
      !input.classList.contains('ui-choice-input') &&
      (input as HTMLInputElement).type !== 'file',
  )
  expect(loose).toEqual([])
})

test('section headings use the one shared subhead, not their own size', async () => {
  render(<SitePage />, container)
  await settle()

  const heads = [...container.querySelectorAll('.ui-panel-body h3')]
  expect(heads.length).toBeGreaterThan(0)
  expect(heads.every((h) => h.classList.contains('ui-subhead'))).toBe(true)
})

test('adding a footer column is offered at the top of that section', async () => {
  /** It used to hang off the bottom of the list, so the button moved further
   *  away the more columns you had. */
  render(<SitePage />, container)
  await settle()

  const links = section('連結欄位')
  expect(links?.querySelector('.ui-section-actions button')?.textContent).toContain('加一欄')
})

test('adding a social link is offered at the top of its own section too', async () => {
  render(<SitePage />, container)
  await settle()

  const socials = section('社群連結')
  expect(socials?.querySelector('.ui-section-actions button')?.textContent).toContain('新增')
})

test('a menu item is added from the panel header, not a form under the list', async () => {
  render(<SitePage />, container)
  await settle()

  expect(panel('選單')?.querySelector('.ui-panel-actions button')?.textContent).toContain('新增項目')

  panel('選單')!.querySelector<HTMLButtonElement>('.ui-panel-actions button')!.click()
  await tick()

  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
})

test('removing a footer column is behind that row own menu', async () => {
  render(<SitePage />, container)
  await settle()

  const column = container.querySelector<HTMLElement>('.footer-columns-editor > li')!
  expect(column.textContent).not.toContain('刪除這一欄')

  column.querySelector<HTMLButtonElement>('.ui-menu-wrap > button')!.click()
  await tick()

  const items = [...container.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())
  expect(items).toContain('刪除這一欄')
})
