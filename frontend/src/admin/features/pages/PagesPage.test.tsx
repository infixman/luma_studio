// @vitest-environment happy-dom

/**
 * The list of built pages, and where a new one is started from.
 *
 * Creating a page is done a handful of times in the life of a shop, and its
 * form had the top of the screen permanently — so the list this page is named
 * for was pushed below it, and the first thing anybody saw on the way to
 * their pages was two empty fields. The courses list and the stockroom lost
 * the same shape the same way.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Page } from '../../../shared/types'

const HOME: Page = {
  id: 'page-1',
  title: '關於苒光',
  path: '/about',
  status: 'published',
  isHome: false,
} as unknown as Page

let pages: Page[] = []

vi.mock('../../../shared/api', () => ({
  STOREFRONT_ORIGIN: 'https://luma-studio.tw',
  api: vi.fn(async () => ({ pages })),
  apiJson: vi.fn(async () => ({})),
}))

vi.mock('../../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { PagesPage } from './PagesPage'

let container: HTMLDivElement

beforeEach(() => {
  pages = []
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

async function settle() {
  for (let turn = 0; turn < 50; turn++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await tick()
  }
  throw new Error('the page never finished loading')
}

function createButton(): HTMLButtonElement | null {
  return container.querySelector('.admin-topbar-actions button')
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]')
}

test('a built page is listed by name and address', async () => {
  pages = [HOME]

  render(<PagesPage />, container)
  await settle()

  expect(container.textContent).toContain('關於苒光')
  expect(container.textContent).toContain('/about')
})

test('the form to start a new one is not sitting on the page', async () => {
  render(<PagesPage />, container)
  await settle()

  expect(dialog()).toBeNull()
  expect(container.querySelector('form')).toBeNull()
})

test('the title bar is where a new page is started', async () => {
  render(<PagesPage />, container)
  await settle()

  expect(createButton()?.textContent).toContain('新增頁面')

  createButton()!.click()
  await tick()

  expect(dialog()).not.toBeNull()
  expect(container.querySelector('form')).not.toBeNull()
})

test('the address follows the name until somebody takes it over', async () => {
  /** The lock starts shut on a page that does not exist yet — there is no
   *  address to protect, so following the title is free. Typing a title and
   *  finding the address still empty is how the old drift started. */
  render(<PagesPage />, container)
  await settle()
  createButton()!.click()
  await tick()

  const [title, path] = [...container.querySelectorAll<HTMLInputElement>('[role="dialog"] input')]
  title!.value = 'About Us'
  title!.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()

  expect(path!.value).toBe('/about-us')
})

/**
 * Row actions.
 *
 * 編輯 and 刪除 sat side by side as two labelled buttons — a full red
 * 刪除 competing for attention on every row of the list, and a shape no
 * other list page uses. Everything that acts on one row now lives behind
 * that row's own menu, the way products, customers and orders already did.
 */
test('a row folds its actions behind one menu instead of loose buttons', async () => {
  pages = [HOME]
  render(<PagesPage />, container)
  await settle()

  const row = container.querySelector<HTMLElement>('.page-list li')!
  expect(row.textContent).not.toContain('刪除')

  row.querySelector<HTMLButtonElement>('.ui-menu-wrap > button')!.click()
  await tick()

  const items = [...container.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())
  expect(items).toContain('編輯')
  expect(items).toContain('刪除')
})
