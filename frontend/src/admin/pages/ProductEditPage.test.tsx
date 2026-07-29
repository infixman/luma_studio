// @vitest-environment happy-dom

/**
 * The edit page in single-offer mode.
 *
 * A product sold without customer-facing options must not present a list of
 * "specifications" to maintain. Which panel appears is decided by
 * `salesMode`, so the only honest check renders the page against a detail
 * response and looks at what came out.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ProductDetail } from '../../shared/types'

const OFFER = {
  id: 'v'.repeat(18),
  productId: 'p'.repeat(18),
  title: '',
  sku: 'BRUSH-01',
  price: 680,
  stock: 20,
  position: 0,
  enabled: true,
  isDefault: true,
}

function detail(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    product: {
      id: 'p'.repeat(18),
      slug: 'brush',
      title: '畫筆',
      description: '',
      status: 'active',
      position: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    variants: [OFFER],
    salesMode: 'single',
    defaultOffer: OFFER,
    images: [],
    categories: [],
    ...overrides,
  }
}

let response: ProductDetail = detail()

vi.mock('../../shared/api', () => ({
  api: vi.fn(async (url: string) =>
    url.startsWith('/api/categories') ? { categories: [] } : response,
  ),
  apiJson: vi.fn(async () => response),
  apiUrl: (path: string) => path,
  uploadProductImage: vi.fn(),
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { ProductEditPage } from './ProductEditPage'

let container: HTMLDivElement

beforeEach(() => {
  response = detail()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

/**
 * Wait for the page to finish loading.
 *
 * The detail and category calls resolve on the microtask queue and Preact
 * re-renders after them, so a single tick is not enough and a fixed number of
 * ticks is a guess that breaks the next time the page gains a fetch. Poll for
 * the spinner's text to go instead.
 */
async function settle() {
  for (let tick = 0; tick < 50; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

function text(): string {
  return container.textContent ?? ''
}

test('a single-offer product shows sales fields instead of a specification list', async () => {
  render(<ProductEditPage id={OFFER.productId} />, container)
  await settle()

  expect(text()).toContain('銷售資訊')
  expect(text()).not.toContain('方案與庫存')
  expect(text()).not.toContain('還沒有銷售方案')
})

test('a multi-offer product shows the plan list instead', async () => {
  response = detail({
    salesMode: 'multi',
    defaultOffer: null,
    variants: [{ ...OFFER, title: 'M', isDefault: false }],
  })

  render(<ProductEditPage id={OFFER.productId} />, container)
  await settle()

  expect(text()).toContain('方案與庫存')
  expect(text()).not.toContain('銷售資訊')
})
