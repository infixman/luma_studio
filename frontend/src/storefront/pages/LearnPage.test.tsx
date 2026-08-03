// @vitest-environment happy-dom

/**
 * Watching a lesson.
 *
 * The one thing here that cannot be seen by reading the component: the server
 * answers with a path, not a URL. Handing that path straight to the player
 * resolves it against the page's own origin — where the storefront Worker
 * answers unknown paths with the SPA shell, so the player is fed an HTML
 * document as a manifest and dies with no error anybody can read. The gateway
 * is on the API host, which is also the host that set the cookie the gateway
 * checks.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const API_ORIGIN = 'https://api.example.test'

// An hour out from whenever the test actually runs, not a fixed epoch: a
// timestamp already in the past makes renewDelay return zero, and the
// session then renews itself on a real-timer loop for the rest of the test,
// tearing LessonPlayer down and rebuilding it between every settle().
function freshSession(): { ok: true; playbackUrl: string; expiresAt: number } {
  return {
    ok: true,
    playbackUrl: '/course-media/asset-1/1/master.m3u8',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }
}

let session: { ok: true; playbackUrl: string; expiresAt: number } | { ok: false; reason: string; message: string } =
  freshSession()

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => ({
    title: '水彩入門',
    sections: [
      {
        title: '第一章',
        lessons: [
          { id: 'lesson-1', title: '調色', contentHtml: '', hasVideo: true, isPreview: false, completed: false },
          { id: 'lesson-2', title: '疊色', contentHtml: '', hasVideo: true, isPreview: false, completed: false },
        ],
      },
    ],
  })),
  apiJson: vi.fn(async () => ({})),
  apiUrl: (path: string) => `${API_ORIGIN}${path}`,
}))

vi.mock('../lib/playback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/playback')>()
  return { ...actual, requestSession: vi.fn(async () => session) }
})

// The real player loads hls.js and then sets `src` from inside it, where the
// URL this page chose is no longer visible. Kept only far enough to prove the
// URL arrived — the ladder and quality menu live in LessonPlayer now, and are
// tested there.
interface PlayerProps {
  src: string
  onEnded?: () => void
}

// `onEnded` is kept because what this page does at the end of a lesson is its
// own behaviour, not the video's.
vi.mock('../../shared/components/HlsVideo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/components/HlsVideo')>()),
  HlsVideo: (props: PlayerProps) => <video data-src={props.src} onEnded={props.onEnded} />,
}))

import { LearnPage } from './LearnPage'

let container: HTMLDivElement

beforeEach(() => {
  session = freshSession()
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('the player is pointed at the gateway, not at the page it is on', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()

  expect(container.querySelector('video')?.getAttribute('data-src')).toBe(
    `${API_ORIGIN}/course-media/asset-1/1/master.m3u8`,
  )
})

test('a refusal is shown instead of a player', async () => {
  session = { ok: false, reason: 'not_entitled', message: '你還沒有這門課程的觀看權' }

  render(<LearnPage slug="watercolour" />, container)
  await settle()

  expect(container.textContent).toContain('你還沒有這門課程的觀看權')
  expect(container.querySelector('video')).toBeNull()
})

// Choosing a rendition and a playback speed is LessonPlayer's own job now —
// see LessonPlayer.test.tsx — so this page only has to prove it hands the
// player a URL and shows a refusal in its place, both above.

/**
 * Playing on into the next lesson.
 *
 * A course is an ordered thing somebody sits through, so the end of a lesson
 * is normally the start of the next one and reaching for the mouse to say so
 * is friction. The choice belongs to this page rather than the player: the
 * player knows a video finished, not that there is another lesson after it.
 */

function endVideo(): void {
  container.querySelector('video')!.dispatchEvent(new Event('ended'))
}

function currentLesson(): string {
  return container.querySelector('.learn-stage h2')?.textContent ?? ''
}

test('a finished lesson runs on into the next one', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  expect(currentLesson()).toBe('調色')

  endVideo()
  await settle()

  expect(currentLesson()).toBe('疊色')
})

test('the switch is on the bar itself, not two taps inside the gear', async () => {
  /** It is changed while watching — at the end of a lesson, when the next one
   *  starts and somebody did not want it to — so it has to be reachable
   *  without opening a menu first. */
  render(<LearnPage slug="watercolour" />, container)
  await settle()

  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="已啟用自動播放功能"]')
  expect(toggle).not.toBeNull()
  expect(toggle!.closest('.player-menu')).toBeNull()
})

test('turning it off leaves the lesson where it ended', async () => {
  /** Somebody who wants to sit with what they just watched, or who is
   *  following along with their hands full, should not be moved on. */
  render(<LearnPage slug="watercolour" />, container)
  await settle()

  container.querySelector<HTMLButtonElement>('button[aria-label="已啟用自動播放功能"]')!.click()
  await settle()

  endVideo()
  await settle()

  expect(currentLesson()).toBe('調色')
})

test('the last lesson stays put rather than wrapping round', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.learn-actions button')]
  buttons.find((button) => button.textContent === '下一單元')!.click()
  await settle()
  expect(currentLesson()).toBe('疊色')

  endVideo()
  await settle()

  expect(currentLesson()).toBe('疊色')
})

test('the choice is remembered, because it is about how somebody watches', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  container.querySelector<HTMLButtonElement>('button[aria-label="已啟用自動播放功能"]')!.click()
  await settle()

  render(null, container)
  render(<LearnPage slug="watercolour" />, container)
  await settle()

  endVideo()
  await settle()
  expect(currentLesson()).toBe('調色')
})

test('theatre mode widens the stage by collapsing the outline beside it', async () => {
  /** The player only says the flag changed; folding the outline away is the
   *  page's layout to own, not the video's. */
  render(<LearnPage slug="watercolour" />, container)
  await settle()

  const layout = container.querySelector('.learn-layout')
  expect(layout?.classList.contains('is-theater')).toBe(false)

  container.querySelector<HTMLButtonElement>('button[aria-label="劇院模式"]')!.click()
  await settle()

  expect(layout?.classList.contains('is-theater')).toBe(true)

  container.querySelector<HTMLButtonElement>('button[aria-label="預設檢視模式"]')!.click()
  await settle()

  expect(layout?.classList.contains('is-theater')).toBe(false)
})
