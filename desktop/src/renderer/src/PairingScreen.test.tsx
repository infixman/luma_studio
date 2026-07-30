// @vitest-environment happy-dom

/**
 * The pairing form.
 *
 * The behaviour worth pinning is what it refuses to send. A six-digit code has
 * an attempt limit behind it, so submitting one the tool can already see is
 * wrong spends part of that limit — a tool that locks its own admin out by being
 * eager is worse than one that says "that is five digits".
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { PairingScreen } from './PairingScreen'
import type { SessionStatus } from '../../shared/session'

const STATUS: SessionStatus = {
  paired: false,
  adminEmail: null,
  secondsLeft: 0,
  remembered: true,
  endpoint: 'https://admin-api.example.com',
  endpointProblem: null,
}

let container: HTMLDivElement
let pair: ReturnType<typeof vi.fn>

beforeEach(() => {
  pair = vi.fn(async () => ({ ok: true, status: { ...STATUS, paired: true } }))
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { version: vi.fn(async () => '1.2.3'), auth: { status: vi.fn(), pair, signOut: vi.fn() } },
  })
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

/**
 * Awaited, and that is the whole point.
 *
 * Preact batches state updates, so typing and submitting in the same tick
 * submits the state from before the typing — every assertion then fails on an
 * empty form and looks like the handler never ran.
 */
async function fill(email: string, code: string): Promise<void> {
  const [emailInput, codeInput] = [...container.querySelectorAll('input')]
  emailInput!.value = email
  emailInput!.dispatchEvent(new Event('input', { bubbles: true }))
  codeInput!.value = code
  codeInput!.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function submit(): void {
  const form = container.querySelector('form')
  if (!form) throw new Error('no form rendered')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a well-formed pair is sent', async () => {
  render(<PairingScreen status={STATUS} onPaired={vi.fn()} />, container)
  await fill('owner@example.com', '418302')
  submit()
  await flush()

  expect(pair).toHaveBeenCalledWith({ email: 'owner@example.com', code: '418302' })
})

test('the space the back office shows is accepted', async () => {
  /** The page renders `418 302`, so that is what gets typed and pasted. */
  render(<PairingScreen status={STATUS} onPaired={vi.fn()} />, container)
  await fill('owner@example.com', '418 302')
  submit()
  await flush()

  expect(pair).toHaveBeenCalledWith({ email: 'owner@example.com', code: '418 302' })
})

test('a short code is not sent at all', async () => {
  /** Sending it would spend an attempt against the lockout for something the
   *  tool could see was wrong. */
  render(<PairingScreen status={STATUS} onPaired={vi.fn()} />, container)
  await fill('owner@example.com', '41830')
  submit()
  await flush()

  expect(pair).not.toHaveBeenCalled()
  expect(container.textContent).toContain('6 位數字')
})

test('a missing email is not sent either', async () => {
  render(<PairingScreen status={STATUS} onPaired={vi.fn()} />, container)
  await fill('', '418302')
  submit()
  await flush()

  expect(pair).not.toHaveBeenCalled()
})

test('a refusal is shown and the code is cleared', async () => {
  /** It is spent either way, so leaving it in the box invites somebody to press
   *  the button again with the same digits. */
  pair.mockResolvedValue({ ok: false, message: '配對失敗，請重新取得驗證碼', httpStatus: 401 })
  render(<PairingScreen status={STATUS} onPaired={vi.fn()} />, container)
  await fill('owner@example.com', '418302')
  submit()
  await flush()

  expect(container.textContent).toContain('配對失敗')
  expect([...container.querySelectorAll('input')][1]!.value).toBe('')
})

test('a machine that cannot remember the pairing is told so', async () => {
  /** Rather than left to discover that pairing does not stick. Nothing is
   *  written in the clear — see main/store.ts. */
  render(<PairingScreen status={{ ...STATUS, remembered: false }} onPaired={vi.fn()} />, container)

  expect(container.textContent).toContain('不會被記住')
})

test('an unusable endpoint blocks the button rather than failing on submit', async () => {
  render(
    <PairingScreen
      status={{ ...STATUS, endpointProblem: '只接受 https（本機開發除外）' }}
      onPaired={vi.fn()}
    />,
    container,
  )

  expect(container.querySelector('button')?.disabled).toBe(true)
  expect(container.textContent).toContain('只接受 https')
})

test('pairing hands the new status upwards', async () => {
  const onPaired = vi.fn()
  render(<PairingScreen status={STATUS} onPaired={onPaired} />, container)
  await fill('owner@example.com', '418302')
  submit()
  await flush()

  expect(onPaired).toHaveBeenCalledWith({ ...STATUS, paired: true })
})
