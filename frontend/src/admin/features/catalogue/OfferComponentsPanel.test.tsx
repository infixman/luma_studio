// @vitest-environment happy-dom

/**
 * What an offer delivers.
 *
 * This panel is the only place an admin can see that a plan grants a course
 * *and* posts a kit. Two things it must never do: work out "needs posting"
 * for itself, and offer a target that is already in the list — wanting two of
 * something is a quantity, and the server refuses a duplicate outright.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Course, InventoryItem, OfferComponentsView } from '../../../shared/types'
import { aCourse, anInventoryItem } from '../../../shared/testing/fixtures'

const COURSE: Course = aCourse()

const KIT: InventoryItem = anInventoryItem()

function view(overrides: Partial<OfferComponentsView> = {}): OfferComponentsView {
  return {
    components: [],
    capabilities: { containsCourse: false, requiresShipping: false, digitalOnly: false, isBundle: false },
    blockers: [],
    ...overrides,
  }
}

let current: OfferComponentsView = view()

vi.mock('../../../shared/api', () => ({
  api: vi.fn(async (url: string) => {
    if (url.startsWith('/api/courses')) return { courses: [COURSE] }
    if (url.startsWith('/api/inventory-items')) return { items: [KIT] }
    return current
  }),
  apiJson: vi.fn(async () => current),
}))

import { OfferComponentsPanel } from './OfferComponentsPanel'

let container: HTMLDivElement

beforeEach(() => {
  current = view()
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
  throw new Error('the panel never finished loading')
}

function options(): string[] {
  return [...container.querySelectorAll('option')].map((option) => option.textContent?.trim() ?? '')
}

test('a mixed offer says both what it grants and that it ships', async () => {
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: null, position: 0 },
      { id: 'c2', offerId: 'off-1', type: 'inventory', componentId: KIT.id, quantity: 1, accessDays: null, position: 1 },
    ],
    capabilities: { containsCourse: true, requiresShipping: true, digitalOnly: false, isBundle: true },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()

  expect(container.textContent).toContain('水彩花卉入門')
  expect(container.textContent).toContain('水彩材料包')
  expect(container.textContent).toContain('需要配送')
})

test('a course-only offer says it needs no delivery', async () => {
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: null, position: 0 },
    ],
    capabilities: { containsCourse: true, requiresShipping: false, digitalOnly: true, isBundle: false },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()

  expect(container.textContent).toContain('不需配送')
})

test('permanent access is stated rather than left blank', async () => {
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: null, position: 0 },
    ],
    capabilities: { containsCourse: true, requiresShipping: false, digitalOnly: true, isBundle: false },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()

  expect(container.textContent).toContain('永久')
})

test('a viewing window is described as counting from first viewing', async () => {
  // "30 days from purchase" and "30 days from first viewing" are different
  // products. The server means the second one.
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: 30, position: 0 },
    ],
    capabilities: { containsCourse: true, requiresShipping: false, digitalOnly: true, isBundle: false },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()

  expect(container.textContent).toContain('觀看後 30 天')
})

test('a target already in the offer is not offered again', async () => {
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: null, position: 0 },
    ],
    capabilities: { containsCourse: true, requiresShipping: false, digitalOnly: true, isBundle: false },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()

  expect(options()).not.toContain(COURSE.title)
})

test('typing a quantity does not save on every keystroke', async () => {
  // The field is a number. Saving per keystroke sends quantity=1 on the way
  // to 12, and sends NaN the moment the field is cleared to retype it.
  const { apiJson } = await import('../../../shared/api')
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'inventory', componentId: KIT.id, quantity: 1, accessDays: null, position: 0 },
    ],
    capabilities: { containsCourse: false, requiresShipping: true, digitalOnly: false, isBundle: false },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()
  vi.mocked(apiJson).mockClear()

  const field = container.querySelector<HTMLInputElement>('input[type="number"]')!
  field.value = ''
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.value = '12'
  field.dispatchEvent(new Event('input', { bubbles: true }))

  expect(apiJson).not.toHaveBeenCalled()

  field.dispatchEvent(new Event('change', { bubbles: true }))

  expect(apiJson).toHaveBeenCalledTimes(1)
  expect(vi.mocked(apiJson).mock.calls[0]![2]).toEqual({
    components: [{ type: 'inventory', componentId: KIT.id, quantity: 12, accessDays: null }],
  })
})

test('clearing the quantity field does not send a quantity of nothing', async () => {
  const { apiJson } = await import('../../../shared/api')
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'inventory', componentId: KIT.id, quantity: 3, accessDays: null, position: 0 },
    ],
    capabilities: { containsCourse: false, requiresShipping: true, digitalOnly: false, isBundle: false },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()
  vi.mocked(apiJson).mockClear()

  const field = container.querySelector<HTMLInputElement>('input[type="number"]')!
  field.value = ''
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))

  expect(apiJson).not.toHaveBeenCalled()
})

test('a reason the offer cannot be sold is shown with the fix', async () => {
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: null, position: 0 },
    ],
    capabilities: { containsCourse: true, requiresShipping: false, digitalOnly: true, isBundle: false },
    blockers: [{ reason: 'course_not_published', message: '課程「水彩花卉入門」尚未發布，發布後才能販售' }],
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()

  expect(container.textContent).toContain('尚未發布')
})

test('removing one component sends the whole remaining set', async () => {
  // The endpoint replaces the set rather than patching it. Sending only the
  // removed item, or only a delta, would be a different contract — and a
  // failed save must leave the offer exactly as it was.
  const { apiJson } = await import('../../../shared/api')
  current = view({
    components: [
      { id: 'c1', offerId: 'off-1', type: 'course', componentId: COURSE.id, quantity: 1, accessDays: 30, position: 0 },
      { id: 'c2', offerId: 'off-1', type: 'inventory', componentId: KIT.id, quantity: 2, accessDays: null, position: 1 },
    ],
    capabilities: { containsCourse: true, requiresShipping: true, digitalOnly: false, isBundle: true },
  })

  render(<OfferComponentsPanel offerId="off-1" />, container)
  await settle()
  vi.mocked(apiJson).mockClear()

  const remove = [...container.querySelectorAll('button')].find((button) =>
    (button.getAttribute('aria-label') ?? '').includes('水彩花卉入門'),
  )!
  remove.click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(vi.mocked(apiJson).mock.calls[0]![2]).toEqual({
    components: [{ type: 'inventory', componentId: KIT.id, quantity: 2, accessDays: null }],
  })
})
