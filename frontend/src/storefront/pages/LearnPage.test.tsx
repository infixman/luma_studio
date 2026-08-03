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
}

vi.mock('../../shared/components/HlsVideo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/components/HlsVideo')>()),
  HlsVideo: (props: PlayerProps) => <video data-src={props.src} />,
}))

import { LearnPage } from './LearnPage'

let container: HTMLDivElement

beforeEach(() => {
  session = freshSession()
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

  container.querySelector<HTMLButtonElement>('button[aria-label="結束劇院模式"]')!.click()
  await settle()

  expect(layout?.classList.contains('is-theater')).toBe(false)
})
