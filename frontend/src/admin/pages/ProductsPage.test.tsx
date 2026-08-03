// @vitest-environment happy-dom

/**
 * The warning about active products nobody can buy.
 *
 * `can_be_active` only refuses this state on write, so rows that reached it
 * before that rule existed stay active and stay invisible. The server decides
 * which products those are; this page only has to surface the answer, and
 * only when there is one — a permanent empty panel would be trained away
 * within a week.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Product, ProductListing } from '../../shared/types'

const GHOST: Product = {
  id: 'p'.repeat(18),
  slug: 'ghost',
  title: '沒有方案的商品',
  description: '',
  status: 'active',
  position: 0,
  createdAt: 0,
  updatedAt: 0,
}

const EMPTY_LISTING: ProductListing = {
  products: [],
  variants: {},
  images: {},
  categories: [],
  counts: {},
  productCategories: {},
}

let unsellable: Product[] = []

vi.mock('../../shared/api', () => ({
  api: vi.fn(async (url: string) => {
    if (url === '/api/products/unsellable') return { products: unsellable }
    return EMPTY_LISTING
  }),
  apiUrl: (path: string) => path,
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { ProductsPage } from './ProductsPage'

let container: HTMLDivElement

beforeEach(() => {
  unsellable = []
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 50; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

test('an active product with no sellable offer is named and linked', async () => {
  unsellable = [GHOST]

  render(<ProductsPage />, container)
  await settle()

  expect(container.textContent).toContain('無法販售的上架商品')
  expect(container.textContent).toContain('沒有方案的商品')

  const links = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))
  expect(links).toContain(`/products/${GHOST.id}`)
})

test('a catalogue with nothing wrong shows no warning at all', async () => {
  render(<ProductsPage />, container)
  await settle()

  expect(container.textContent).not.toContain('無法販售的上架商品')
})

/**
 * The page says its own name once.
 *
 * The navigation highlights 商品, the title bar reads 商品, and the panel
 * over the only table on the page read 商品 a third time. Six other list
 * pages had already dropped that panel title; this one had not.
 */
test('the product list does not repeat the page title over itself', async () => {
  render(<ProductsPage />, container)
  await settle()

  const titles = [...container.querySelectorAll('.ui-panel-title')].map((h) => h.textContent?.trim())
  expect(titles).not.toContain('商品')
})

test('adding a product is offered from the title bar, like every other list', async () => {
  render(<ProductsPage />, container)
  await settle()

  const action = container.querySelector('.admin-topbar-actions button, .admin-topbar-actions a')
  expect(action?.textContent).toContain('新增商品')
})
