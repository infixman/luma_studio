// @vitest-environment happy-dom

/**
 * An order that may contain two very different kinds of thing.
 *
 * A course is available the moment payment lands. A kit is not. Showing them
 * in one undifferentiated list makes the whole order look like it is still in
 * the post, and a member who already has access goes looking for a tracking
 * number that does not exist.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { OrderDetail, OrderFulfillment } from '../../shared/types'

function fulfillment(overrides: Partial<OrderFulfillment> = {}): OrderFulfillment {
  return {
    id: 'ff-1',
    type: 'course',
    targetId: 'course-1',
    targetTitle: '水彩花卉入門',
    sku: null,
    quantity: 1,
    accessDays: null,
    status: 'fulfilled',
    ...overrides,
  }
}

function detail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    order: {
      id: 'LS20260730abcdefg',
      status: 'paid',
      subtotal: 3980,
      shippingFee: 0,
      total: 3980,
      shippingMethod: 'none',
      recipientName: '王小明',
      recipientPhone: '',
      recipientEmail: 'buyer@example.com',
      shippingAddress: '',
      storeName: null,
      storeAddr: null,
      reservedUntil: null,
      paidAt: 1,
      createdAt: 0,
    },
    items: [
      {
        productTitle: '水彩入門',
        variantTitle: '',
        unitPrice: 3980,
        quantity: 1,
        subtotal: 3980,
        slug: 'watercolour',
        coverPath: null,
      },
    ],
    fulfillments: [fulfillment()],
    ...overrides,
  } as OrderDetail
}

let current: OrderDetail = detail()

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => current),
  apiJson: vi.fn(async () => current),
  apiUrl: (path: string) => path,
}))

import { OrderPage } from './OrderPage'

let container: HTMLDivElement

beforeEach(() => {
  current = detail()
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

test('a course is shown as available rather than on its way', async () => {
  render(<OrderPage id="LS20260730abcdefg" />, container)
  await settle()

  expect(container.textContent).toContain('數位內容')
  expect(container.textContent).toContain('已開通')
  expect(container.textContent).not.toContain('待出貨內容')
})

test('an order with nothing to post shows no recipient card', async () => {
  // A card of empty fields reads as data that went missing.
  render(<OrderPage id="LS20260730abcdefg" />, container)
  await settle()

  expect(container.textContent).not.toContain('收件資料')
})

test('a mixed order separates what is granted from what is being sent', async () => {
  current = detail({
    fulfillments: [
      fulfillment(),
      fulfillment({ id: 'ff-2', type: 'inventory', targetId: 'kit-1', targetTitle: '水彩材料包', sku: 'KIT-1', status: 'pending' }),
    ],
  })

  render(<OrderPage id="LS20260730abcdefg" />, container)
  await settle()

  expect(container.textContent).toContain('數位內容')
  expect(container.textContent).toContain('待出貨內容')
  expect(container.textContent).toContain('收件資料')
})

test('a viewing window is described as counting from first viewing', async () => {
  current = detail({ fulfillments: [fulfillment({ accessDays: 30 })] })

  render(<OrderPage id="LS20260730abcdefg" />, container)
  await settle()

  expect(container.textContent).toContain('觀看後 30 天')
})

test('permanent access is stated rather than left blank', async () => {
  render(<OrderPage id="LS20260730abcdefg" />, container)
  await settle()

  expect(container.textContent).toContain('永久觀看')
})
