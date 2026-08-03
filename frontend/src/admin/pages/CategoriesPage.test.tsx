// @vitest-environment happy-dom

/**
 * Product categories.
 *
 * This page carried the back office's two loudest inconsistencies at once:
 * its create form sat permanently above the list, on a page whose whole
 * subject is the list, and it invented its own section headings — two of
 * them, each with a caption underneath restating what the heading already
 * said. It also padded its panel to 48px where every other page uses 16.
 *
 * What is pinned here is the shape it was moved onto: create from the title
 * bar into a dialog, delete from the row's own menu, and one list with no
 * headings over it at all.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Category } from '../../shared/types'

const PHYSICAL: Category = {
  id: 'c'.repeat(18),
  slug: 'in-person',
  title: '實體課程',
  description: '',
  position: 0,
}

let categories: Category[] = []
const posted: { url: string; body: unknown }[] = []

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => ({ categories, counts: { [PHYSICAL.id]: 3 } })),
  apiJson: vi.fn(async (url: string, _method: string, body: unknown) => {
    posted.push({ url, body })
    return {}
  }),
  apiUrl: (path: string) => path,
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { CategoriesPage } from './CategoriesPage'

let container: HTMLDivElement

beforeEach(() => {
  categories = []
  posted.length = 0
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
  for (let i = 0; i < 40; i++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await tick()
  }
}

function createButton(): HTMLButtonElement | null {
  return container.querySelector('.admin-topbar-actions button')
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]')
}

function menuItem(label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
      (item.textContent ?? '').includes(label),
    ) ?? null
  )
}

test('the form to add a category is not sitting on the page', async () => {
  render(<CategoriesPage />, container)
  await settle()

  expect(dialog()).toBeNull()
  expect(container.querySelector('form')).toBeNull()
})

test('the title bar is where a category is added from', async () => {
  render(<CategoriesPage />, container)
  await settle()

  expect(createButton()?.textContent).toContain('新增分類')

  createButton()!.click()
  await tick()

  expect(dialog()).not.toBeNull()
})

test('creating posts what was typed', async () => {
  render(<CategoriesPage />, container)
  await settle()

  createButton()!.click()
  await tick()

  const name = dialog()!.querySelector('input')!
  name.value = '線上課程'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()

  dialog()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  await tick()
  await tick()
  await tick()

  expect(posted[0]?.url).toBe('/api/categories')
})

test('the page does not head its own list with headings it invented', async () => {
  /** 新增分類 and 現有分類 were two h2s at a size no other page used, each
   *  with a caption under it restating the heading. One list needs neither. */
  categories = [PHYSICAL]
  render(<CategoriesPage />, container)
  await settle()

  expect(container.textContent).not.toContain('現有分類')
  expect(container.textContent).not.toContain('用分類整理商品')
  expect(container.textContent).not.toContain('直接修改名稱')
})

test('what a category is gets said where one is being made', async () => {
  render(<CategoriesPage />, container)
  await settle()

  createButton()!.click()
  await tick()

  expect(dialog()?.textContent).toContain('前台分類頁')
})

test('deleting is offered from the row own menu, not a loose icon', async () => {
  categories = [PHYSICAL]
  render(<CategoriesPage />, container)
  await settle()

  const row = container.querySelector<HTMLElement>('.category-list li')!
  row.querySelector<HTMLButtonElement>('.ui-menu-wrap > button')!.click()
  await tick()

  expect(menuItem('刪除')).not.toBeNull()
})

test('an empty list still says what the page is for', async () => {
  render(<CategoriesPage />, container)
  await settle()

  expect(container.textContent).toContain('還沒有分類')
})
