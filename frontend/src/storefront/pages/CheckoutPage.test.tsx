// @vitest-environment happy-dom

/**
 * Checking out something with nobody to deliver to.
 *
 * The server stopped requiring a delivery method, a phone number and an
 * address for a cart of courses. This page has to agree, or a member who
 * bought a course is stopped at a form asking where to post it.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CartLine, CartQuote } from '../../shared/contracts/cart'

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    variantId: 'off-1',
    offerId: 'off-1',
    productSlug: 'watercolour',
    productTitle: '水彩入門',
    variantTitle: '',
    offerTitle: null,
    imagePath: null,
    unitPrice: 3980,
    quantity: 1,
    lineTotal: 3980,
    containsCourse: false,
    requiresShipping: true,
    components: [{ type: 'inventory', title: '材料包' }],
    stockLeft: null,
    ...overrides,
  }
}

function physical(): CartQuote {
  return {
    lines: [line()],
    problems: [],
    subtotal: 3980,
    shippingSubtotal: 3980,
    requiresShipping: true,
    containsCourse: false,
    shipping: [{ method: 'home', label: '宅配到府', fee: 120, freeThreshold: null }],
  }
}

function digital(): CartQuote {
  return {
    lines: [line({ containsCourse: true, requiresShipping: false, components: [{ type: 'course', title: '水彩花卉入門' }] })],
    problems: [],
    subtotal: 3980,
    shippingSubtotal: 0,
    requiresShipping: false,
    containsCourse: true,
    shipping: [],
  }
}

let quote: CartQuote = physical()
const posted: { url: string; body: unknown }[] = []

vi.mock('../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api')>()
  return {
    ...actual,
    api: vi.fn(async () => ({ customer: { recipientName: '', recipientPhone: '', address: '', email: 'a@b.c' } })),
    apiJson: vi.fn(async (url: string, _method: string, body: unknown) => {
      posted.push({ url, body })
      if (url === '/api/cart/validate') return quote
      return { order: { id: 'LS1' } }
    }),
    loginUrl: () => '/login',
  }
})

vi.mock('../lib/cart', () => ({
  read: () => [{ variantId: 'off-1', quantity: 1 }],
  clear: vi.fn(),
  MAX_QUANTITY: 100000,
}))

import { CheckoutPage } from './CheckoutPage'

let container: HTMLDivElement

beforeEach(() => {
  quote = physical()
  posted.length = 0
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test('a cart of courses is not asked how to deliver it', async () => {
  quote = digital()

  render(<CheckoutPage />, container)
  await settle()

  expect(container.textContent).not.toContain('配送方式')
})

test('a cart of courses is not asked for a phone number', async () => {
  // Nobody is going to ring about a download.
  quote = digital()

  render(<CheckoutPage />, container)
  await settle()

  expect(container.textContent).not.toContain('手機')
})

test('a cart of courses can still be submitted', async () => {
  // The submit button used to be disabled until a delivery method was chosen,
  // and a digital cart is never offered one.
  quote = digital()

  render(<CheckoutPage />, container)
  await settle()

  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')
  expect(submit?.disabled).toBe(false)
})

test('a physical cart is still asked for everything', async () => {
  render(<CheckoutPage />, container)
  await settle()

  expect(container.textContent).toContain('配送方式')
  expect(container.textContent).toContain('手機')
})

test('a digital order does not send a delivery method it was never given', async () => {
  quote = digital()

  render(<CheckoutPage />, container)
  await settle()

  const name = container.querySelector<HTMLInputElement>('input[name="recipientName"]')!
  name.value = '王小明'
  name.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()

  const checkout = posted.find((entry) => entry.url === '/api/checkout')
  expect(checkout).toBeDefined()
  expect((checkout!.body as Record<string, unknown>).shippingMethod).toBeUndefined()
})
