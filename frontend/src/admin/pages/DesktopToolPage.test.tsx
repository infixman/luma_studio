// @vitest-environment happy-dom

/**
 * The page that authorises a desktop tool.
 *
 * The code is not secret in any deep sense — the server generates and verifies
 * it — so what makes showing one meaningful is that only a signed-in admin can
 * see this screen. The parts worth testing are the ones that would present as
 * "my correct code was rejected": a countdown that starts from the server's
 * remaining seconds rather than from thirty, and a refetch when the window ends
 * rather than a code computed here.
 *
 * No fake timers. Preact schedules effects on `requestAnimationFrame`, which
 * vitest fakes along with everything else, and a frozen clock never delivers one
 * — so the page never loads at all. The countdown tests instead ask the server
 * for a one-second window and wait for it, which costs about a second each and
 * needs no explanation.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { DesktopReleaseList } from '../../shared/types'

const pairings: { code: string; expiresInSeconds: number; adminEmail: string }[] = []
let calls = 0
let failStatus: number | null = null
let policy = {
  latest: '1.2.0',
  minSupported: '1.0.0',
  forceUpdate: false,
  blocked: false,
  notes: '',
  feedUrl: 'https://admin-api.example.com/releases',
  updatedAt: 0,
}
const saved: unknown[] = []

// What the record says now, and what a refresh would find. Two values rather
// than one, because the whole point of the panel is that the second only
// arrives when somebody asks for it.
let recorded: DesktopReleaseList = { versions: [], hasFeed: false, refreshedAt: null }
let inTheBucket: DesktopReleaseList = { versions: [], hasFeed: false, refreshedAt: null }
let deleteRefusal: string | null = null
const requests: { path: string; method: string }[] = []

// The real ApiError, so the page's `instanceof` check means what it says. Only
// the fetching is replaced.
vi.mock('../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api')>()
  return {
    ...actual,
    api: vi.fn(async (path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET'
      requests.push({ path, method })
      if (path.startsWith('/api/desktop/version-policy')) return policy
      if (path.startsWith('/api/desktop/releases')) {
        if (method === 'DELETE') {
          if (deleteRefusal !== null) throw new actual.ApiError(deleteRefusal, 409, {})
          recorded = {
            ...recorded,
            versions: recorded.versions.filter(
              (entry) => !path.endsWith(encodeURIComponent(entry.version)),
            ),
          }
          return { deleted: 1 }
        }
        return recorded
      }
      if (failStatus !== null) throw new actual.ApiError('nope', failStatus, {})
      calls += 1
      return pairings[Math.min(calls - 1, pairings.length - 1)]
    }),
    apiJson: vi.fn(async (path: string, method: string, body: unknown) => {
      requests.push({ path, method })
      if (path === '/api/desktop/releases/refresh') {
        recorded = inTheBucket
        return recorded
      }
      saved.push(body)
      return policy
    }),
  }
})

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { DesktopToolPage } from './DesktopToolPage'

let container: HTMLDivElement

beforeEach(() => {
  // The copy buttons write to it; jsdom-alikes do not provide one.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
  calls = 0
  failStatus = null
  saved.length = 0
  policy = {
    latest: '1.2.0',
    minSupported: '1.0.0',
    forceUpdate: false,
    blocked: false,
    notes: '',
    feedUrl: 'https://admin-api.example.com/releases',
    updatedAt: 0,
  }
  pairings.length = 0
  pairings.push({ code: '418302', expiresInSeconds: 20, adminEmail: 'owner@example.com' })
  requests.length = 0
  deleteRefusal = null
  // Nobody has looked yet, which is not the same as an empty bucket.
  recorded = { versions: [], hasFeed: false, refreshedAt: null }
  inTheBucket = {
    versions: [
      {
        version: '1.2.0',
        files: ['luma-video-uploader-1.2.0-setup.exe', 'luma-video-uploader-1.2.0-setup.exe.blockmap'],
        bytes: 94_690_523,
        uploadedAt: 1_785_292_800,
      },
      {
        version: '0.9.0',
        files: ['luma-video-uploader-0.9.0-setup.exe'],
        bytes: 90_000_000,
        uploadedAt: 1_784_292_800,
      },
    ],
    hasFeed: true,
    refreshedAt: 1_785_300_000,
  }
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

/** The same shape as the other page tests. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 30; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('it shows the code as the digits the tool wants', async () => {
  /** Not grouped: it is copied with the button beside it rather than read
   *  across a room, and an ungrouped code is what the server accepts. */
  render(<DesktopToolPage />, container)
  await settle()

  expect(container.querySelector('.desktop-pairing-code')?.textContent).toBe('418302')
})

test('the code is still readable to a screen reader digit by digit', async () => {
  render(<DesktopToolPage />, container)
  await settle()

  expect(container.querySelector('.desktop-pairing-code')?.getAttribute('aria-label')).toBe(
    '驗證碼 4 1 8 3 0 2',
  )
})

test('it shows the email, because the tool asks for both', async () => {
  render(<DesktopToolPage />, container)
  await settle()

  expect(container.textContent).toContain('owner@example.com')
})

test('the countdown starts at what the server said, not at thirty', async () => {
  /** A local thirty-second timer drifts out of step with the window it claims
   *  to describe, and the symptom is a correct code being rejected. */
  render(<DesktopToolPage />, container)
  await settle()

  expect(container.textContent).toContain('20 秒')
})

test('it counts down', async () => {
  pairings[0] = { code: '418302', expiresInSeconds: 3, adminEmail: 'owner@example.com' }
  render(<DesktopToolPage />, container)
  await settle()

  await wait(1050)

  expect(container.textContent).toContain('2 秒')
})

test('it fetches the next code when the window ends rather than computing one', async () => {
  /** The code comes from a seed this page never sees, so there is nothing here
   *  that could compute the next one — it has to ask. */
  pairings[0] = { code: '418302', expiresInSeconds: 1, adminEmail: 'owner@example.com' }
  pairings.push({ code: '999111', expiresInSeconds: 30, adminEmail: 'owner@example.com' })
  render(<DesktopToolPage />, container)
  await settle()

  await wait(1200)

  expect(calls).toBe(2)
  expect(container.querySelector('.desktop-pairing-code')?.textContent).toBe('999111')
})

test('an unconfigured worker is explained rather than reported as an error', async () => {
  failStatus = 503
  render(<DesktopToolPage />, container)
  await settle()

  expect(container.textContent).toContain('DESKTOP_PAIRING_SECRET')
})

test('the email can be copied rather than retyped', async () => {
  render(<DesktopToolPage />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '複製信箱',
  )
  button?.click()

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('owner@example.com')
})

test('the code copies as digits, not as the spaced form', async () => {
  /** The tool strips separators anyway, but pasting exactly what the server
   *  accepts is one fewer thing that can be wrong. */
  render(<DesktopToolPage />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '複製驗證碼',
  )
  button?.click()

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('418302')
})

test('copying says so, because otherwise nobody knows it worked', async () => {
  render(<DesktopToolPage />, container)
  await settle()

  const button = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '複製驗證碼',
  )
  button?.click()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  expect(container.querySelector('[aria-label="已複製"]')).not.toBeNull()
})


test('the version policy is shown with the download link the server reports', async () => {
  /** A link typed here is a link that is wrong on whichever deployment is not
   *  production, and wrong quietly. */
  render(<DesktopToolPage />, container)
  await settle()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  // The values live in inputs, not in the page's text.
  const values = [...container.querySelectorAll('input')].map((input) => input.value)
  expect(values).toContain('1.0.0')
  const link = [...container.querySelectorAll('a')].find((element) =>
    (element.getAttribute('href') ?? '').includes('/releases/latest.yml'),
  )
  expect(link).not.toBeUndefined()
})

test('the unsigned installer is explained rather than left to look broken', async () => {
  /** SmartScreen's warning is the first thing an admin sees when installing, and
   *  it reads as "this is malware" rather than "nobody bought a certificate". */
  render(<DesktopToolPage />, container)
  await settle()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  expect(container.textContent).toContain('SmartScreen')
})

test('saving sends what the form says, not what was loaded', async () => {
  /** Asserted after typing, because a form that posts the values it was given
   *  passes every check made without touching it. */
  render(<DesktopToolPage />, container)
  await settle()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  const latest = [...container.querySelectorAll('input')].find((input) => input.value === '1.2.0')
  latest!.value = '1.4.0'
  latest!.dispatchEvent(new Event('input', { bubbles: true }))
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  const save = [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes('儲存'),
  )
  save?.click()
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))

  expect(saved).toEqual([
    {
      latest: '1.4.0',
      minSupported: '1.0.0',
      forceUpdate: false,
      blocked: false,
      notes: '',
    },
  ])
})

/**
 * The release list, which is the one part of this page that costs money to be
 * wrong about: a listing is billed, and a row for an object that is no longer
 * there hands somebody a download link to a 404.
 */

/** Rendered and settled, including the panels below the pairing code. */
async function open(): Promise<void> {
  render(<DesktopToolPage />, container)
  await settle()
  await idle()
}

async function idle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function buttonSaying(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(text),
  )
}

function deleteButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((element) =>
    (element.textContent ?? '').includes('刪除'),
  )
}

async function loadTheList(): Promise<void> {
  buttonSaying('重新載入 R2')?.click()
  await idle()
}

test('the list is not fetched from R2 until somebody asks for it', async () => {
  /** Listing a bucket is billed and this page is opened rarely. A panel that
   *  refreshed itself would be a page costing money while nobody reads it. */
  await open()

  expect(requests.some((request) => request.path.includes('/releases/refresh'))).toBe(false)
  expect(container.textContent).toContain('尚未載入')
})

test('pressing the button lists what R2 actually holds', async () => {
  await open()
  await loadTheList()

  expect(requests.some((request) => request.path === '/api/desktop/releases/refresh')).toBe(true)
  expect(container.textContent).toContain('1.2.0')
  expect(container.textContent).toContain('0.9.0')
})

test('the download URL is built from the feed the server reports', async () => {
  /** A host typed here is a host that is wrong on whichever deployment is not
   *  production, and the symptom is a copied link that 404s. */
  await open()
  await loadTheList()

  const copy = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '複製 1.2.0 的下載網址',
  )
  copy?.click()

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
    'https://admin-api.example.com/releases/luma-video-uploader-1.2.0-setup.exe',
  )
})

test('the version the policy publishes cannot be deleted, and says why', async () => {
  /** Every installed tool is being told to update to it. The server refuses it
   *  as well — this is the half somebody can see before clicking. */
  await open()
  await loadTheList()

  const refused = deleteButtons()[0]
  expect(refused?.disabled).toBe(true)
  expect(refused?.getAttribute('title') ?? '').toContain('最新版本')
})

test('deleting asks first, and names the version', async () => {
  await open()
  await loadTheList()

  deleteButtons()[1]?.click()
  await idle()
  // In the dialog, not merely somewhere on the page: the table lists both
  // versions, so "the page mentions 0.9.0" would be true without asking.
  expect(container.querySelector('[role="dialog"]')?.textContent ?? '').toContain('0.9.0')

  buttonSaying('確定刪除')?.click()
  await idle()

  expect(
    requests.some(
      (request) => request.method === 'DELETE' && request.path === '/api/desktop/releases/0.9.0',
    ),
  ).toBe(true)
})

test('a refusal from the server is shown rather than swallowed', async () => {
  /** The page disables what it knows about; the server knows about the rest,
   *  and its answer is the one that decides. */
  deleteRefusal = '這是版本政策的最低支援版本'
  await open()
  await loadTheList()

  deleteButtons()[1]?.click()
  await idle()
  buttonSaying('確定刪除')?.click()
  await idle()

  expect(container.textContent).toContain('這是版本政策的最低支援版本')
})

test('a missing latest.yml is called out, because nothing else would show it', async () => {
  /** Without the feed every installed tool goes on believing it is current,
   *  and every version in this list looks perfectly fine. */
  inTheBucket = { ...inTheBucket, hasFeed: false }
  await open()
  await loadTheList()

  // Not just the string `latest.yml`, which the download section prints anyway.
  expect(container.textContent).toContain('沒有 latest.yml')
})

test('the copy is HTML, not markdown source', async () => {
  /** `**所有**` renders as four asterisks on screen. Nothing in this page is
   *  run through a markdown renderer — a paragraph written as if it were is a
   *  page that looks unfinished. */
  render(<DesktopToolPage />, container)
  await settle()

  expect(container.textContent).not.toContain('**')
})
