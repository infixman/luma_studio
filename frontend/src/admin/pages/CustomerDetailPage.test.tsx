// @vitest-environment happy-dom

/**
 * A member's course access, from the shop's side.
 *
 * The load-bearing part of this screen is the difference between the reasons
 * somebody holds a course. A purchase is taken back by recording the refund
 * that justifies it; a gift has no order to refund and so needs a way back of
 * its own. Drawing the same button for both would offer one that the server
 * refuses, which teaches people that the buttons lie.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type {
  AdminCustomerDetail,
  Course,
  CustomerEntitlement,
  EntitlementSource,
} from '../../shared/types'
import { aCourse } from '../../shared/testing/fixtures'

const CUSTOMER_ID = 'cus_000000000000000001'

const DETAIL: AdminCustomerDetail = {
  customer: {
    id: CUSTOMER_ID,
    email: 'mei@example.com',
    displayName: '小美',
    recipientName: '',
    recipientPhone: '',
    address: '',
    blocked: false,
    cartBlocked: false,
    accountBlocked: false,
    notes: '',
    anonymizedAt: null,
    createdAt: 1_700_000_000,
    orderCount: 0,
    paidTotal: 0,
  },
  orders: [],
  activity: [],
  stats: { periodDays: 30, lastSeenAt: null, pageViews: 0, productViews: 0, cartAdds: 0 },
}

function aGift(overrides: Partial<EntitlementSource> = {}): EntitlementSource {
  return {
    id: 's-gift',
    kind: 'gift',
    fulfillmentId: null,
    actor: 'owner@example.com',
    reason: '客訴補償',
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...overrides,
  }
}

function aPurchase(overrides: Partial<EntitlementSource> = {}): EntitlementSource {
  return {
    id: 's-buy',
    kind: 'purchase',
    fulfillmentId: 'ff-1',
    actor: null,
    reason: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    ...overrides,
  }
}

/** A source that was taken away, and so is the one restoring acts on. */
function revoked(source: EntitlementSource): EntitlementSource {
  return { ...source, revokedAt: 1_700_000_500, revokedBy: 'owner@example.com', revokeReason: '誤送' }
}

function anEntitlement(overrides: Partial<CustomerEntitlement> = {}): CustomerEntitlement {
  return {
    id: 'ent-1',
    customerId: CUSTOMER_ID,
    courseId: 'course-1',
    courseTitle: '水彩花卉入門',
    grantedAt: 1_700_000_000,
    accessDays: null,
    firstViewedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokeReason: null,
    active: true,
    sources: [aGift()],
    history: [],
    ...overrides,
  }
}

let entitlements: CustomerEntitlement[] = []
let courses: Course[] = []

vi.mock('../../shared/api', () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(async (path: string) => {
    if (path.endsWith('/entitlements')) return { entitlements }
    if (path.startsWith('/api/courses')) return { courses }
    return DETAIL
  }),
  apiJson: vi.fn(async () => ({ granted: true, entitlements })),
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { CustomerDetailPage } from './CustomerDetailPage'

let container: HTMLDivElement

beforeEach(() => {
  entitlements = []
  courses = [aCourse({ status: 'published' })]
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  vi.clearAllMocks()
  render(null, container)
  container.remove()
})

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function settle() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await tick()
  }
  throw new Error('the page never finished loading')
}

async function show() {
  render(<CustomerDetailPage id={CUSTOMER_ID} />, container)
  await settle()
}

function accessPanel(): HTMLElement {
  const panel = [...container.querySelectorAll<HTMLElement>('.ui-panel')].find((section) =>
    section.querySelector('.ui-panel-title')?.textContent?.includes('課程觀看權'),
  )
  if (!panel) throw new Error('the access panel is not on the page')
  return panel
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]')
}

function buttonSaying(text: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  )
  if (!found) throw new Error(`no button saying ${text}`)
  return found
}

async function type(field: HTMLInputElement, value: string) {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  // Preact batches, so the typed value is not in state until it re-renders.
  await tick()
}

test('a member with no courses is told what would put one there', async () => {
  await show()

  expect(accessPanel().textContent).toContain('還沒有任何課程')
})

test('a course is named, not only identified', async () => {
  entitlements = [anEntitlement()]

  await show()

  expect(accessPanel().textContent).toContain('水彩花卉入門')
  expect(accessPanel().textContent).toContain('永久')
})

test('a timed grant nobody has played yet is not called permanent', async () => {
  // It has no expiry date because the clock has not started, which is not the
  // same thing as having no clock. The shop would find out the difference
  // when the member complained.
  entitlements = [anEntitlement({ accessDays: 30, expiresAt: null })]

  await show()

  expect(accessPanel().textContent).toContain('尚未開始')
  expect(accessPanel().textContent).not.toContain('永久')
})

test('a revoked grant says so rather than looking expired', async () => {
  entitlements = [anEntitlement({ revokedAt: 1_700_000_500, active: false, revokeReason: '誤送' })]

  await show()

  expect(accessPanel().textContent).toContain('已撤銷')
})

test('a purchase offers no revoke button, and a gift does', async () => {
  entitlements = [anEntitlement({ sources: [aPurchase()] })]

  await show()

  expect(accessPanel().textContent).toContain('購買')
  expect([...accessPanel().querySelectorAll('tbody button')]).toHaveLength(0)
  expect(accessPanel().textContent).toContain('由訂單的退款流程撤銷')
})

/** Opens the grant dialog and picks the only course on offer. */
async function openGrantAndPickCourse() {
  buttonSaying('授與課程', accessPanel()).click()
  await tick()
  await tick()
  // The course picker is this back office's own listbox, not a <select>.
  buttonSaying('選一門課', dialog()!).click()
  await tick()
  ;(dialog()!.querySelector('[role="option"]') as HTMLElement).click()
  await tick()
}

function fieldLabelled(text: string): HTMLInputElement {
  const field = [...dialog()!.querySelectorAll('.ui-field')].find((entry) =>
    entry.querySelector('.ui-label')?.textContent?.includes(text),
  )
  if (!field) throw new Error(`no field labelled ${text}`)
  return field.querySelector('input')!
}

/** By label rather than by text: the hint beside 補發 mentions 觀看天數 too. */
function hasFieldLabelled(text: string): boolean {
  return [...dialog()!.querySelectorAll('.ui-field .ui-label')].some((label) =>
    label.textContent?.includes(text),
  )
}

async function chooseKind(label: string) {
  const choice = [...dialog()!.querySelectorAll('.ui-choice')].find((entry) =>
    entry.querySelector('.ui-choice-label')?.textContent?.includes(label),
  )
  if (!choice) throw new Error(`no kind called ${label}`)
  choice.querySelector('input')!.click()
  await tick()
}

test('gifting sends the course and the reason it was given', async () => {
  const { apiJson } = await import('../../shared/api')

  await show()
  await openGrantAndPickCourse()

  await type(fieldLabelled('原因'), '客訴補償')
  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await tick()

  const [path, method, body] = vi.mocked(apiJson).mock.calls[0]!
  expect(path).toContain('/entitlements/gift')
  expect(method).toBe('POST')
  expect(body).toMatchObject({ courseId: 'course-1', reason: '客訴補償' })
})

test('a grant cannot be given without saying why', async () => {
  await show()
  await openGrantAndPickCourse()

  // A grant nobody can account for is one nobody can undo with confidence.
  expect(buttonSaying('贈送', dialog()!.querySelector('.ui-modal-footer')!).disabled).toBe(true)
})

test('a course they can already watch is shown but cannot be picked again', async () => {
  entitlements = [anEntitlement()]

  await show()
  buttonSaying('授與課程', accessPanel()).click()
  await tick()
  await tick()
  buttonSaying('選一門課', dialog()!).click()
  await tick()

  const option = dialog()!.querySelector('[role="option"]')!
  expect(option.textContent).toContain('已有觀看權')
  expect(option.getAttribute('aria-disabled')).toBe('true')
})

test('a re-issue goes to its own endpoint, not the gift one', async () => {
  /** The two are different claims about what happened, and the accounts read
   *  differently for each. */
  const { apiJson } = await import('../../shared/api')

  await show()
  await openGrantAndPickCourse()
  await chooseKind('補發')
  await type(fieldLabelled('原因'), '付款當下漏開通')
  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await tick()

  const [path] = vi.mocked(apiJson).mock.calls[0]!
  expect(path).toContain('/entitlements/grant')
  expect(path).not.toContain('/entitlements/gift')
})

test('only a re-issue is asked how long it lasts', async () => {
  // A gift with a countdown on it is a strange thing to give somebody.
  await show()
  await openGrantAndPickCourse()

  expect(hasFieldLabelled('觀看天數')).toBe(false)

  await chooseKind('補發')

  expect(hasFieldLabelled('觀看天數')).toBe(true)
})

test('a re-issue carries the term the member actually bought', async () => {
  const { apiJson } = await import('../../shared/api')

  await show()
  await openGrantAndPickCourse()
  await chooseKind('補發')
  await type(fieldLabelled('觀看天數'), '30')
  await type(fieldLabelled('原因'), '補發')
  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await tick()

  expect(vi.mocked(apiJson).mock.calls[0]![2]).toMatchObject({ accessDays: '30' })
})

test('a re-issue is steered away from the case it would break', async () => {
  /** A hand-made grant has no fulfilment to name it by, so a later refund
   *  would not take it back. */
  await show()
  await openGrantAndPickCourse()
  await chooseKind('補發')

  expect(dialog()!.textContent).toContain('重新開通')
})

test('a re-issue can be revoked, the same as a gift', async () => {
  entitlements = [anEntitlement({ sources: [aGift({ id: 's-manual', kind: 'manual', reason: '補發' })] })]

  await show()

  expect(accessPanel().textContent).toContain('補發')
  expect(buttonSaying('撤銷', accessPanel())).toBeTruthy()
})

test('revoking a gift names the source and the reason', async () => {
  const { apiJson } = await import('../../shared/api')
  entitlements = [anEntitlement()]

  await show()
  buttonSaying('撤銷', accessPanel()).click()
  await tick()

  expect(dialog()!.textContent).toContain('會員會立刻無法觀看')

  await type(dialog()!.querySelector('input')!, '誤送')
  buttonSaying('撤銷', dialog()!.querySelector('.ui-modal-footer')!).click()
  await tick()

  const [path, , body] = vi.mocked(apiJson).mock.calls[0]!
  expect(path).toContain('/entitlements/revoke')
  expect(body).toMatchObject({ sourceId: 's-gift', reason: '誤送' })
})

test('revoking a gift they also paid for says the access stays', async () => {
  /** Being surprised by that afterwards is how somebody revokes twice. */
  entitlements = [anEntitlement({ sources: [aGift(), aPurchase()] })]

  await show()
  buttonSaying('撤銷', accessPanel()).click()
  await tick()

  expect(dialog()!.textContent).toContain('仍然可以觀看')
})

test('a revoked source can be put back, whichever kind it is', async () => {
  // A refund recorded against the wrong order is the case this exists for, so
  // refusing to restore a purchase would leave that unfixable.
  entitlements = [anEntitlement({ sources: [revoked(aPurchase())], revokedAt: 1_700_000_500, active: false })]

  await show()

  expect(buttonSaying('恢復', accessPanel())).toBeTruthy()
})

test('restoring names the source and the reason', async () => {
  const { apiJson } = await import('../../shared/api')
  entitlements = [anEntitlement({ sources: [revoked(aGift())], revokedAt: 1_700_000_500, active: false })]

  await show()
  buttonSaying('恢復', accessPanel()).click()
  await tick()

  // The reason it went is the thing somebody deciding to put it back needs.
  expect(dialog()!.textContent).toContain('當初撤銷的原因：誤送')

  await type(dialog()!.querySelector('input')!, '誤撤銷')
  buttonSaying('恢復觀看權', dialog()!).click()
  await tick()

  const [path, , body] = vi.mocked(apiJson).mock.calls[0]!
  expect(path).toContain('/entitlements/restore')
  expect(body).toMatchObject({ sourceId: 's-gift', reason: '誤撤銷' })
})

test('restoring says it does not hand the days back', async () => {
  entitlements = [
    anEntitlement({ accessDays: 30, sources: [revoked(aGift())], revokedAt: 1_700_000_500, active: false }),
  ]

  await show()
  buttonSaying('恢復', accessPanel()).click()
  await tick()

  expect(dialog()!.textContent).toContain('不會補回來')
})

test('restoring a window that has already run out says so before the click', async () => {
  /** Restoring does not reset the clock, so this is the case where the button
   *  does what it says and the member still sees nothing. */
  entitlements = [
    anEntitlement({
      accessDays: 30,
      firstViewedAt: 1_600_000_000,
      expiresAt: 1_600_100_000,
      sources: [revoked(aGift())],
      revokedAt: 1_700_000_500,
      active: false,
    }),
  ]

  await show()
  buttonSaying('恢復', accessPanel()).click()
  await tick()

  expect(dialog()!.textContent).toContain('恢復之後會員還是看不到')
})

test('a course that was revoked and put back still shows it happened', async () => {
  // The source row says nothing about it any more — restoring clears the
  // revocation off it — so without the record the page would read as though
  // the course had sat there untouched.
  entitlements = [
    anEntitlement({
      history: [
        { sourceId: 's-gift', actor: 'owner@example.com', action: 'restore', reason: '誤撤銷', createdAt: 1_700_000_900 },
        { sourceId: 's-gift', actor: 'owner@example.com', action: 'revoke', reason: '誤送', createdAt: 1_700_000_500 },
      ],
    }),
  ]

  await show()

  const history = accessPanel().querySelector('.entitlement-history')!
  expect(history.textContent).toContain('恢復')
  expect(history.textContent).toContain('誤撤銷')
  expect(history.textContent).toContain('撤銷')
  expect(history.textContent).toContain('誤送')
})
