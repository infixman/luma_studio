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

let session: { ok: true; playbackUrl: string; expiresAt: number } | { ok: false; reason: string; message: string } = {
  ok: true,
  playbackUrl: '/course-media/asset-1/1/master.m3u8',
  expiresAt: 1_700_000_900,
}

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => ({
    title: '水彩入門',
    sections: [
      {
        title: '第一章',
        lessons: [
          { id: 'lesson-1', title: '調色', contentHtml: '', hasVideo: true, isPreview: false, completed: false },
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
// URL this page chose is no longer visible.
vi.mock('../../shared/components/HlsVideo', () => ({
  HlsVideo: ({ src }: { src: string }) => <video data-src={src} />,
}))

import { LearnPage } from './LearnPage'

let container: HTMLDivElement

beforeEach(() => {
  session = { ok: true, playbackUrl: '/course-media/asset-1/1/master.m3u8', expiresAt: 1_700_000_900 }
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
