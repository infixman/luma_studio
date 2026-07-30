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
import type { VersionState } from '../../shared/versionGate'

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
let versionAnswer: { state: unknown; message: string } = { state: null, message: '' }

function resetVersion(): void {
  versionAnswer = { state: null, message: '' }
}

function bridge(status: SessionStatus) {
  const signOut = vi.fn(async () => UNPAIRED)
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      version: vi.fn(async () => '1.2.3'),
      versionState: vi.fn(async () => versionAnswer),
      auth: { status: vi.fn(async () => status), pair: vi.fn(), signOut },
      upload: { scan: vi.fn(), start: vi.fn(), cancel: vi.fn(), onProgress: () => () => {} },
      clipboard: vi.fn(async () => ''),
      prefs: { read: vi.fn(async () => ({ rememberedEmail: '' })), rememberEmail: vi.fn() },
      pathFor: vi.fn(() => ''),
    },
  })
  return { signOut }
}

beforeEach(() => {
  resetVersion()
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
  expect(container.querySelectorAll('.code-slot')).toHaveLength(6)
})

test('with a pairing it says who it is connected as', async () => {
  bridge(PAIRED)
  render(<App />, container)
  await settle()

  expect(container.textContent).toContain('owner@example.com')
})

test('the licence is reachable from the screen people actually sit on', async () => {
  /** Not a detail of the About component: the GPL obligation is only met if
   *  the way in is present on the screen the tool spends its life showing. */
  bridge(PAIRED)
  render(<App />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('授權條款'),
  )

  expect(button).toBeDefined()
})

test('and it is there before pairing too', async () => {
  /** Somebody who cannot pair -- wrong code, no back office to hand -- would
   *  never reach the licence of a GPL binary this tool already shipped them. */
  bridge(UNPAIRED)
  render(<App />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('授權條款'),
  )

  expect(button).toBeDefined()
})

test('logging out returns to the pairing screen', async () => {
  const { signOut } = bridge(PAIRED)
  render(<App />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('登出'),
  )
  button?.click()
  for (let tick = 0; tick < 30 && !container.textContent?.includes('連結管理後台'); tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  expect(signOut).toHaveBeenCalled()
  expect(container.textContent).toContain('連結管理後台')
})


function versionSaying(state: VersionState, message: string): void {
  versionAnswer = { state, message }
}

test('a build the server stopped does not get an upload screen', async () => {
  /** Disabling the drop target would leave a tool that refuses files silently,
   *  which reads as broken rather than as out of date. */
  versionSaying(
    {
      verdict: { allowed: false, mustUpdate: true, updateAvailable: true, reason: 'blocked' },
      latest: '2.0.0',
      notes: '',
    },
    '這個版本已被停用，請安裝新版之後再繼續。（最新版本 2.0.0）',
  )
  bridge(PAIRED)
  render(<App />, container)
  await settle()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  expect(container.textContent).toContain('已被停用')
  expect(container.querySelector('.drop')).toBeNull()
})

test('a build with an update available keeps working and says so', async () => {
  /** Two levers: "there is a new one" and "you cannot work". Blurring them
   *  teaches people to ignore both. */
  versionSaying(
    {
      verdict: { allowed: true, mustUpdate: false, updateAvailable: true, reason: 'ok' },
      latest: '2.0.0',
      notes: '',
    },
    '有新版本 2.0.0 可以更新。',
  )
  bridge(PAIRED)
  render(<App />, container)
  await settle()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  expect(container.textContent).toContain('有新版本')
  expect(container.querySelector('.drop')).not.toBeNull()
})
