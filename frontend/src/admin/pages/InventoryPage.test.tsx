// @vitest-environment happy-dom

/**
 * The stockroom.
 *
 * The point of this screen is that a count here belongs to every offer that
 * includes the item, which is exactly what the product editor cannot show. So
 * the sharing has to be visible: an item used by three offers must say so
 * before anyone types a new number into it.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { InventoryItem } from '../../shared/types'
import { anInventoryItem } from '../../shared/testing/fixtures'

const KIT: InventoryItem = anInventoryItem()

let items: InventoryItem[] = []

/**
 * Requests the test can answer in whatever order it likes.
 *
 * `manual` mode is how the search race is reproduced: two searches are in
 * flight and the earlier one comes back last.
 */
let manual = false
const pending: { url: string; resolve: (value: unknown) => void }[] = []

vi.mock('../../shared/api', () => ({
  api: vi.fn((url: string) => {
    if (!url.startsWith('/api/inventory-items')) return Promise.resolve({})
    if (!manual) return Promise.resolve({ items })
    return new Promise((resolve) => pending.push({ url, resolve }))
  }),
  apiJson: vi.fn(async () => ({ item: KIT })),
  apiUrl: (path: string) => path,
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { InventoryPage } from './InventoryPage'

let container: HTMLDivElement

beforeEach(() => {
  items = []
  manual = false
  pending.length = 0
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

/** One turn of the microtask queue, so Preact can re-render. */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function settle() {
  for (let tick = 0; tick < 50; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

test('an item shows its code and how many there are', async () => {
  items = [KIT]

  render(<InventoryPage />, container)
  await settle()

  expect(container.textContent).toContain('水彩材料包')
  expect(container.textContent).toContain('KIT-1')
  expect(container.textContent).toContain('12')
})

test('an empty stockroom explains what the screen is for', async () => {
  render(<InventoryPage />, container)
  await settle()

  expect(container.textContent).toContain('還沒有庫存品')
})

// A missing SKU is normal, and an empty cell reads as a rendering fault.
test('an item with no code is not shown as blank', async () => {
  items = [{ ...KIT, sku: '' }]

  render(<InventoryPage />, container)
  await settle()

  expect(container.textContent).toContain('—')
})

test('a slow earlier search does not overwrite the newer results', async () => {
  // Type "a", then "ab". The request for "a" is still in flight when the one
  // for "ab" lands. Whoever finishes last must not be the one that wins, or
  // the list ends up showing results for text the admin has moved past.
  manual = true
  items = [KIT]

  render(<InventoryPage />, container)
  await tick()

  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
  search.value = 'ab'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()

  const initial = pending.find((request) => !request.url.includes('q='))!
  const narrowed = pending.find((request) => request.url.includes('q=ab'))!

  narrowed.resolve({ items: [KIT] })
  await tick()
  initial.resolve({ items: [] })
  await tick()

  expect(container.textContent).toContain('水彩材料包')
})
