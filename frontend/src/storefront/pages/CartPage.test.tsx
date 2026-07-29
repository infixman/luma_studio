// @vitest-environment happy-dom

/**
 * A cart that might hold nothing you can post.
 *
 * The page used to assume every line was a parcel. Asking a customer who
 * bought a course to choose between ways of sending them nothing is the kind
 * of thing that makes people abandon a checkout.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CartLine, CartQuote } from '../../shared/contracts/cart'

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    variantId: 'off-1',
    offerId: 'off-1',
    productSlug: 'watercolour-set',
    productTitle: '水彩完整套組',
    variantTitle: '',
    offerTitle: null,
    imagePath: null,
    unitPrice: 3980,
    quantity: 1,
    lineTotal: 3980,
    containsCourse: false,
    requiresShipping: true,
    components: [{ type: 'inventory', title: '水彩材料包' }],
    stockLeft: null,
    ...overrides,
  }
}

function quote(overrides: Partial<CartQuote> = {}): CartQuote {
  return {
    lines: [line()],
    problems: [],
    subtotal: 3980,
    shippingSubtotal: 3980,
    requiresShipping: true,
    containsCourse: false,
    shipping: [{ method: 'home', label: '宅配到府', fee: 120, freeThreshold: null }],
    ...overrides,
  }
}

let current: CartQuote = quote()

vi.mock('../../shared/api', () => ({
  apiJson: vi.fn(async () => current),
  apiUrl: (path: string) => path,
}))

vi.mock('../lib/cart', () => ({
  read: () => [{ variantId: 'off-1', quantity: 1 }],
  write: vi.fn(),
  forget: vi.fn(),
  setQuantity: vi.fn(),
  MAX_QUANTITY: 100000,
}))

import { CartPage } from './CartPage'

let container: HTMLDivElement

beforeEach(() => {
  current = quote()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a cart of courses alone is not asked how to deliver them', async () => {
  current = quote({
    lines: [
      line({
        containsCourse: true,
        requiresShipping: false,
        components: [{ type: 'course', title: '水彩花卉入門' }],
      }),
    ],
    shippingSubtotal: 0,
    requiresShipping: false,
    containsCourse: true,
    shipping: [],
  })

  render(<CartPage />, container)
  await settle()

  expect(container.textContent).not.toContain('配送方式')
  expect(container.textContent).toContain('不需要配送')
})

test('a course line offers no quantity to change', async () => {
  // One purchase is one grant. A spinner suggesting otherwise is a lie the
  // server would have to refuse anyway.
  current = quote({
    lines: [
      line({
        containsCourse: true,
        requiresShipping: false,
        components: [{ type: 'course', title: '水彩花卉入門' }],
      }),
    ],
    requiresShipping: false,
    containsCourse: true,
    shipping: [],
  })

  render(<CartPage />, container)
  await settle()

  expect(container.querySelector('input[type="number"]')).toBeNull()
})

test('a cart with anything physical still asks how to deliver it', async () => {
  render(<CartPage />, container)
  await settle()

  expect(container.textContent).toContain('配送方式')
})

test('a product sold without options is not labelled with an empty spec', async () => {
  render(<CartPage />, container)
  await settle()

  expect(container.textContent).not.toContain('規格：')
})

test('what a plan includes is named before payment', async () => {
  current = quote({
    lines: [
      line({
        containsCourse: true,
        components: [
          { type: 'course', title: '水彩花卉入門' },
          { type: 'inventory', title: '水彩材料包' },
        ],
      }),
    ],
    containsCourse: true,
  })

  render(<CartPage />, container)
  await settle()

  expect(container.textContent).toContain('水彩花卉入門')
})

test('free delivery counts only what is being delivered', async () => {
  // A course in the basket must not read as progress towards a threshold it
  // contributes nothing to.
  current = quote({
    lines: [line(), line({ offerId: 'off-2', variantId: 'off-2', requiresShipping: false, containsCourse: true })],
    subtotal: 7960,
    shippingSubtotal: 3980,
    containsCourse: true,
    shipping: [{ method: 'home', label: '宅配到府', fee: 120, freeThreshold: 5000 }],
  })

  render(<CartPage />, container)
  await settle()

  expect(container.textContent).toContain('再買 NT$1020 就免運')
})
