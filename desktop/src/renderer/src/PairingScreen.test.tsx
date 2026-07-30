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
let clipboard: ReturnType<typeof vi.fn>
let rememberEmail: ReturnType<typeof vi.fn>
let remembered: string

beforeEach(() => {
  remembered = ''
  pair = vi.fn(async () => ({ ok: true, status: { ...STATUS, paired: true } }))
  clipboard = vi.fn(async () => '')
  rememberEmail = vi.fn(async (email: string) => ({ rememberedEmail: email }))
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      version: vi.fn(async () => '1.2.3'),
      clipboard,
      prefs: { read: vi.fn(async () => ({ rememberedEmail: remembered })), rememberEmail },
      auth: { status: vi.fn(), pair, signOut: vi.fn() },
    },
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
async function mount(onPaired: () => void = vi.fn()): Promise<void> {
  render(<PairingScreen status={STATUS} onPaired={onPaired} />, container)
  // The remembered address arrives from an effect and then a promise, so a
  // single tick is not enough — anything typed before it lands is overwritten.
  await flush()
}

/** By type, not by position: a checkbox sits between the two text fields. */
function emailField(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[type="email"]')!
}

/** The code is six slots now. Filling the first one with the whole value is a
 *  paste, which the component spreads across them. */
function codeSlots(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('.code-slot')]
}

function codeValue(): string {
  return codeSlots()
    .map((slot) => slot.value)
    .join('')
}

async function fill(email: string, code: string): Promise<void> {
  const emailInput = emailField()
  emailInput.value = email
  emailInput.dispatchEvent(new Event('input', { bubbles: true }))
  // A separate tick, because a person does not fill two fields in one. Filling
  // them together used to submit the state from before the typing.
  await new Promise((resolve) => setTimeout(resolve, 0))

  const first = codeSlots()[0]!
  first.value = code
  first.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function submitButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (element) => element.type === 'submit',
  ) as HTMLButtonElement | undefined
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
  await mount()
  await fill('owner@example.com', '418302')
  submit()
  await flush()

  expect(pair).toHaveBeenCalledWith({ email: 'owner@example.com', code: '418302' })
})

test('the space the back office shows is accepted', async () => {
  /** The page renders `418 302`, so that is what gets pasted. The slots spread
   *  it and hand back digits, so what reaches the server is already clean. */
  await mount()
  await fill('owner@example.com', '418 302')
  await flush()

  expect(pair).toHaveBeenCalledWith({ email: 'owner@example.com', code: '418302' })
})

test('a short code is not sent at all', async () => {
  /** Sending it would spend an attempt against the lockout for something the
   *  tool could see was wrong. */
  await mount()
  await fill('owner@example.com', '41830')
  submit()
  await flush()

  expect(pair).not.toHaveBeenCalled()
  // Five digits cannot even fill the slots, so the form refuses on submit.
  expect(container.textContent).toContain('6 位數字')
})

test('a missing email is not sent either', async () => {
  await mount()
  await fill('', '418302')
  submit()
  await flush()

  expect(pair).not.toHaveBeenCalled()
})

test('a refusal is shown and the code is cleared', async () => {
  /** It is spent either way, so leaving it in the box invites somebody to press
   *  the button again with the same digits.
   *
   *  No explicit submit: six digits send on their own, so pressing the button
   *  afterwards would be submitting the empty field this test is checking for. */
  pair.mockResolvedValue({ ok: false, message: '配對失敗，請重新取得驗證碼', httpStatus: 401 })
  await mount()
  await fill('owner@example.com', '418302')
  await flush()

  expect(container.textContent).toContain('配對失敗')
  expect(codeValue()).toBe('')
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

  expect(submitButton()?.disabled).toBe(true)
  expect(container.textContent).toContain('只接受 https')
})

test('pairing hands the new status upwards', async () => {
  const onPaired = vi.fn()
  await mount(onPaired)
  await fill('owner@example.com', '418302')
  await flush()

  expect(onPaired).toHaveBeenCalledWith({ ...STATUS, paired: true })
})

test('a remembered address is filled in on launch', async () => {
  /** The code changes every thirty seconds; the address does not. Typing it
   *  again each time is a step that only costs seconds off the window. */
  remembered = 'owner@example.com'
  await mount()

  expect(emailField().value).toBe('owner@example.com')
})

test('and the checkbox reflects that it was remembered', async () => {
  remembered = 'owner@example.com'
  await mount()

  const check = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(check?.checked).toBe(true)
})

test('nothing is remembered unless the box is ticked', async () => {
  await mount()
  await fill('owner@example.com', '418302')
  submit()
  await flush()

  expect(rememberEmail).toHaveBeenCalledWith('')
})

test('ticking the box remembers the address', async () => {
  await mount()
  await fill('owner@example.com', '418302')
  container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
  await flush()
  submit()
  await flush()

  expect(rememberEmail).toHaveBeenCalledWith('owner@example.com')
})

test('the paste button puts the clipboard into the email field', async () => {
  clipboard.mockResolvedValue('  owner@example.com  ')
  await mount()

  const paste = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '貼上信箱',
  )
  paste?.click()
  await flush()

  expect(emailField().value).toBe('owner@example.com')
})

test('six digits pair on their own once there is an address', async () => {
  /** The code is short-lived and typed by hand; a separate button press only
   *  ever costs seconds off the window. */
  await mount()
  await fill('owner@example.com', '418302')
  await flush()

  expect(pair).toHaveBeenCalledWith({ email: 'owner@example.com', code: '418302' })
})

test('five digits do not', async () => {
  await mount()
  await fill('owner@example.com', '41830')
  await flush()

  expect(pair).not.toHaveBeenCalled()
})

test('six digits with no address wait rather than spending an attempt', async () => {
  await mount()
  await fill('', '418302')
  await flush()

  expect(pair).not.toHaveBeenCalled()
})

test('the same digits are not sent twice', async () => {
  /** A code is spent by the attempt. Firing again on every keystroke after the
   *  sixth would walk the admin into the lockout a character at a time. */
  pair.mockResolvedValue({ ok: false, message: '配對失敗', httpStatus: 401 })
  await mount()
  await fill('owner@example.com', '418302')
  await flush()
  await fill('owner@example.com', '418302')
  await flush()

  expect(pair).toHaveBeenCalledTimes(1)
})
