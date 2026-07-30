// @vitest-environment happy-dom

/**
 * The video library.
 *
 * Until this screen existed the uploads were invisible: the desktop tool said
 * "ready" and nothing in the back office could confirm it, list what was there,
 * or retire anything. So the parts worth testing are the ones an admin would
 * otherwise have to take on trust — that a failure says why, that the list keeps
 * up with a transcode in progress without being reloaded by hand, and that
 * retiring a video asks first and reports the server's refusal.
 *
 * Only `setInterval` is faked. Faking everything takes `requestAnimationFrame`
 * with it, which is how Preact schedules effects — the page then never loads at
 * all (see DesktopToolPage.test.tsx, which waits in real time instead). Faking
 * the one timer the polling uses keeps the three-second test instant.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { VideoAsset } from '../../shared/types'
import { aVideoAsset } from '../../shared/testing/fixtures'

let assets: VideoAsset[] = []
let listCalls = 0
let listFailure: { status: number; message: string } | null = null
// The payload is recorded too. `apiJson` takes three arguments, and a mock that
// accepted two let a call missing its body pass every test in this file — tsc
// caught it, which is not a thing to rely on twice.
const posted: { path: string; method: string; body: unknown }[] = []
let archiveFailure: { status: number; message: string } | null = null

vi.mock('../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api')>()
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path.startsWith('/api/video-assets')) {
        listCalls += 1
        if (listFailure && listCalls > 1) {
          throw new actual.ApiError(listFailure.message, listFailure.status, {})
        }
        return { assets }
      }
      return {}
    }),
    apiJson: vi.fn(async (path: string, method: string, body: unknown) => {
      posted.push({ path, method, body })
      if (archiveFailure) throw new actual.ApiError(archiveFailure.message, archiveFailure.status, {})
      return { asset: assets[0] }
    }),
  }
})

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { VideoLibraryPage } from './VideoLibraryPage'

let container: HTMLDivElement

beforeEach(() => {
  assets = []
  listCalls = 0
  posted.length = 0
  archiveFailure = null
  listFailure = null
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

/** Let effects and promises run without letting the poll timer advance. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function buttonFor(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(label) || element.getAttribute('aria-label') === label,
  )
}

/** Row actions live behind the table's `⋯` menu, as they do on every other page. */
async function openRowMenu(): Promise<void> {
  buttonFor('這一列的動作')?.click()
  await flush()
}

function statusText(): string {
  return container.querySelector('#status')?.textContent ?? ''
}

test('a video is listed with what it is', async () => {
  assets = [aVideoAsset()]

  render(<VideoLibraryPage />, container)
  await settle()

  expect(container.textContent).toContain('第一課：工具介紹')
  expect(container.textContent).toContain('可播放')
  expect(container.textContent).toContain('1.4 GB')
  expect(container.textContent).toContain('12:34')
})

test('a failed video says why', async () => {
  /** Otherwise the only way to find out is the machine that did the transcode,
   *  which is not the machine the admin is looking at. */
  assets = [aVideoAsset({ status: 'failed', errorCode: 'transcode', errorDetail: 'ffmpeg 退出碼 1' })]

  render(<VideoLibraryPage />, container)
  await settle()

  expect(container.textContent).toContain('轉檔失敗')
  expect(container.textContent).toContain('ffmpeg 退出碼 1')
})

test('an empty library explains what to do rather than showing a bare table', async () => {
  render(<VideoLibraryPage />, container)
  await settle()

  expect(container.textContent).toContain('桌面上傳工具')
})

test('it keeps up with a transcode without being reloaded by hand', async () => {
  assets = [aVideoAsset({ status: 'processing' })]

  render(<VideoLibraryPage />, container)
  await settle()
  const first = listCalls

  vi.advanceTimersByTime(3_000)
  await flush()

  expect(listCalls).toBe(first + 1)
})

test('it stops asking once the page is gone', async () => {
  /** A poll that outlives its page is a request against a session that may be
   *  gone, and a setState into nothing. */
  assets = [aVideoAsset()]
  render(<VideoLibraryPage />, container)
  await settle()
  const before = listCalls

  render(null, container)
  vi.advanceTimersByTime(9_000)
  await flush()

  expect(listCalls).toBe(before)
})

test('it stops asking while the tab is in the background', async () => {
  /** Nobody is reading it, and this is a tab people leave open all day. */
  assets = [aVideoAsset({ status: 'processing' })]
  render(<VideoLibraryPage />, container)
  await settle()
  const before = listCalls

  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  document.dispatchEvent(new Event('visibilitychange'))
  vi.advanceTimersByTime(9_000)
  await flush()

  expect(listCalls).toBe(before)

  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  document.dispatchEvent(new Event('visibilitychange'))
  await flush()

  // And picks up again on return, rather than needing a reload.
  expect(listCalls).toBeGreaterThan(before)
})

test('retiring a video asks first, and names it', async () => {
  assets = [aVideoAsset()]
  render(<VideoLibraryPage />, container)
  await settle()

  await openRowMenu()
  buttonFor('封存')?.click()
  await flush()

  expect(container.textContent).toContain('第一課：工具介紹')
  expect(posted).toEqual([])
})

test('confirming sends the archive', async () => {
  assets = [aVideoAsset()]
  render(<VideoLibraryPage />, container)
  await settle()

  await openRowMenu()
  buttonFor('封存')?.click()
  await flush()
  buttonFor('確定封存')?.click()
  await flush()

  expect(posted).toEqual([{ path: '/api/video-assets/asset-1/archive', method: 'POST', body: {} }])
})

test('an archive that worked says so', async () => {
  /** `run` shows whatever the work returns *instead of* the success message, and
   *  the archive endpoint answers with the asset — which rendered as an empty
   *  status bar: no error, no confirmation, nothing. */
  assets = [aVideoAsset()]
  render(<VideoLibraryPage />, container)
  await settle()

  await openRowMenu()
  buttonFor('封存')?.click()
  await flush()
  buttonFor('確定封存')?.click()
  await flush()

  expect(statusText()).toContain('影片已封存')
})

test('a refusal is shown as the server phrased it', async () => {
  /** The server names the lesson still using the video. Replacing that with a
   *  generic failure would leave the admin with no idea what to change. */
  assets = [aVideoAsset()]
  // A lesson name that is not part of the asset's own title: asserting on
  // "工具介紹" would have passed with no message shown at all, because the video
  // in the fixture is called 第一課：工具介紹.
  archiveFailure = { status: 409, message: '這支影片正被單元「渲染與縫合」使用，請先替換影片' }
  render(<VideoLibraryPage />, container)
  await settle()

  await openRowMenu()
  buttonFor('封存')?.click()
  await flush()
  buttonFor('確定封存')?.click()
  await flush()

  expect(container.textContent).toContain('渲染與縫合')
})

test('a video still uploading offers no archive button', async () => {
  /** The state machine refuses that move, so the button's only possible outcome
   *  is a 409. Offering an action that cannot work is worse than not offering
   *  one: it reads as a fault in the system rather than a rule of it. */
  assets = [aVideoAsset({ status: 'uploading', encodeVersion: null })]

  render(<VideoLibraryPage />, container)
  await settle()

  await openRowMenu()

  expect(buttonFor('封存')).toBeUndefined()
})

test('an unfinished upload shows dashes rather than zeros', async () => {
  /** It was never probed, so there is no length, no size and no version. `0` and
   *  `v0` would each be a claim about the file. */
  assets = [aVideoAsset({ status: 'uploading', durationSeconds: null, byteSize: 0, encodeVersion: null })]

  render(<VideoLibraryPage />, container)
  await settle()

  const cells = [...container.querySelectorAll('tbody td')].map((cell) => cell.textContent)
  expect(cells.filter((text) => text === '—')).toHaveLength(3)
})

test('a failing refresh is not announced, because nobody asked for it', async () => {
  /** Every three seconds it would replace whatever the admin's own last action
   *  said — including the confirmation of an archive that worked. */
  assets = [aVideoAsset({ status: 'processing' })]
  listFailure = { status: 500, message: '伺服器錯誤' }
  render(<VideoLibraryPage />, container)
  await settle()

  vi.advanceTimersByTime(3_000)
  await flush()

  expect(statusText()).not.toContain('伺服器錯誤')
})

test('a refresh that keeps failing gives up and says so', async () => {
  /** A poll retrying forever is a page that never recovers and never admits it. */
  assets = [aVideoAsset({ status: 'processing' })]
  listFailure = { status: 500, message: '伺服器錯誤' }
  render(<VideoLibraryPage />, container)
  await settle()

  // One interval at a time, and settled in between: three ticks fired back to
  // back would be three overlapping requests, and only the newest one's failure
  // counts — the generation guard drops the rest, which is what it is for.
  for (let attempt = 0; attempt < 3; attempt++) {
    vi.advanceTimersByTime(3_000)
    await flush()
  }
  const afterGivingUp = listCalls

  vi.advanceTimersByTime(3_000 * 5)
  await flush()

  expect(container.textContent).toContain('自動更新已停止')
  expect(listCalls).toBe(afterGivingUp)
})

test('a session that has gone stops the refresh at once', async () => {
  /** The api client has already sent the visitor to sign in again. Three more
   *  polls are three requests against nothing. */
  assets = [aVideoAsset({ status: 'processing' })]
  listFailure = { status: 401, message: '請重新登入' }
  render(<VideoLibraryPage />, container)
  await settle()

  vi.advanceTimersByTime(3_000)
  await flush()
  const afterFirstFailure = listCalls

  vi.advanceTimersByTime(3_000 * 5)
  await flush()

  expect(listCalls).toBe(afterFirstFailure)
})
