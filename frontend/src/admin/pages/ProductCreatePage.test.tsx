// @vitest-environment happy-dom

/**
 * The create page in single-offer mode.
 *
 * Phase 1 removed the step where an admin had to invent a "specification"
 * before a product could be sold. That promise is only visible in what the
 * page renders, so it is checked by rendering it: a name field for the offer
 * reappearing would undo the change without failing any other test.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => ({ categories: [] })),
  apiJson: vi.fn(async () => ({ product: { id: 'p'.repeat(18) } })),
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { ProductCreatePage } from './ProductCreatePage'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

/** Preact renders and the category fetch resolves on the microtask queue. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function labels(): string[] {
  return [...container.querySelectorAll('label')].map((label) => label.textContent?.trim() ?? '')
}

test('sales fields are asked for without a name for the offer', async () => {
  render(<ProductCreatePage />, container)
  await settle()

  const asked = labels().join(' ')
  expect(asked).toContain('售價')
  expect(asked).toContain('庫存')
  expect(asked).toContain('貨號')
  // The single offer is created by the server and never named by hand.
  expect(asked).not.toContain('規格')
  expect(asked).not.toContain('方案名稱')
})

test('the create button stays disabled until price and stock are given', async () => {
  render(<ProductCreatePage />, container)
  await settle()

  const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')
  expect(submit?.disabled).toBe(true)
})
