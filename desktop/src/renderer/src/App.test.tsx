// @vitest-environment happy-dom

/**
 * Which screen the tool opens on.
 *
 * The decision belongs to the main process — it holds the token — so what is
 * worth testing here is that this component believes it, including the case
 * where a remembered pairing has expired and the answer is the pairing screen
 * rather than an upload screen that refuses everything.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from './App'
import type { SessionStatus } from '../../shared/session'

const PAIRED: SessionStatus = {
  paired: true,
  adminEmail: 'owner@example.com',
  secondsLeft: 43_200,
  remembered: true,
  endpoint: 'https://admin-api.example.com',
  endpointProblem: null,
}

const UNPAIRED: SessionStatus = { ...PAIRED, paired: false, adminEmail: null, secondsLeft: 0 }

let container: HTMLDivElement

function bridge(status: SessionStatus) {
  const signOut = vi.fn(async () => UNPAIRED)
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      version: vi.fn(async () => '1.2.3'),
      auth: { status: vi.fn(async () => status), pair: vi.fn(), signOut },
    },
  })
  return { signOut }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 30; tick++) {
    if (!(container.textContent ?? '').includes('讀取中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the status never arrived')
}

test('with no pairing it asks for a code', async () => {
  bridge(UNPAIRED)
  render(<App />, container)
  await settle()

  expect(container.textContent).toContain('連結管理後台')
  expect(container.querySelector('.code-input')).not.toBeNull()
})

test('with a pairing it says who it is connected as', async () => {
  bridge(PAIRED)
  render(<App />, container)
  await settle()

  expect(container.textContent).toContain('owner@example.com')
})

test('it says the tool holds no R2 key', async () => {
  /** The sentence somebody needs before installing this on a laptop. */
  bridge(PAIRED)
  render(<App />, container)
  await settle()

  expect(container.textContent).toContain('沒有 R2 金鑰')
})

test('unlinking returns to the pairing screen', async () => {
  const { signOut } = bridge(PAIRED)
  render(<App />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('取消連結'),
  )
  button?.click()
  for (let tick = 0; tick < 30 && !container.textContent?.includes('連結管理後台'); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  expect(signOut).toHaveBeenCalled()
  expect(container.textContent).toContain('連結管理後台')
})
