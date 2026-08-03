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
// URL this page chose is no longer visible.
//
// The props are kept so a test can be the player: hand the page a ladder the
// way the manifest would, and read back which rung it asked for. AUTO_LEVEL
// comes from the real module — a stand-in for it would let the page and the
// player disagree about what "auto" is and still pass.
interface PlayerProps {
  src: string
  level?: number
  onRenditions?: (renditions: { index: number; height: number }[]) => void
  onPlayingRendition?: (height: number | null) => void
}

let player: PlayerProps = { src: '' }

vi.mock('../../shared/components/HlsVideo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/components/HlsVideo')>()),
  HlsVideo: (props: PlayerProps) => {
    player = props
    return <video data-src={props.src} />
  },
}))

import { AUTO_LEVEL } from '../../shared/components/HlsVideo'
import { LearnPage } from './LearnPage'

let container: HTMLDivElement

beforeEach(() => {
  session = { ok: true, playbackUrl: '/course-media/asset-1/1/master.m3u8', expiresAt: 1_700_000_900 }
  player = { src: '' }
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

/**
 * Choosing a rendition.
 *
 * The player has been able to play a chosen rung for a while — `level`,
 * `onRenditions` and `onPlayingRendition` are all there and tested. Nothing
 * ever passed them. Two halves, each correct, each green, and between them a
 * feature that did not exist: the only quality menu on the page was the
 * browser's own right-click menu, which never has one, because hls.js feeds
 * the element through MSE and the browser cannot know a ladder exists.
 */
const LADDER = [
  { index: 0, height: 480 },
  { index: 1, height: 720 },
  { index: 2, height: 1080 },
]

async function announce(renditions: { index: number; height: number }[], playing: number | null = null) {
  player.onRenditions?.(renditions)
  player.onPlayingRendition?.(playing)
  await settle()
}

function qualityButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.quality button')]
}

function labels(): string[] {
  return qualityButtons().map((button) => (button.textContent ?? '').trim())
}

function press(label: string): void {
  qualityButtons().find((button) => (button.textContent ?? '').includes(label))!.click()
}

test('nothing to choose between means nothing to choose from', async () => {
  /** One rung is not a ladder. A control offering a single option is a
   *  control that asks a question with one answer. */
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce([{ index: 0, height: 720 }], 720)

  expect(container.querySelector('.quality')).toBeNull()
})

test('the ladder is offered highest first, under an automatic default', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce(LADDER, 1080)

  // Descending, because somebody opening this wants the good one and should
  // not have to read to the end of the row to find it.
  expect(labels()).toEqual(['自動 · 1080p', '1080p', '720p', '480p'])
})

test('automatic says which rung it actually settled on', async () => {
  /** The whole reason the player reports this: on a slow connection the
   *  choice hls.js makes is the answer to "why does this look soft", and
   *  without it "自動" is a word that explains nothing. */
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce(LADDER, 480)

  expect(labels()[0]).toBe('自動 · 480p')
})

test('picking one hands the player that rung', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce(LADDER, 1080)

  press('720p')
  await settle()

  // The player's own index, not the height — they are not the same number and
  // the manifest decides the order.
  expect(player.level).toBe(1)
})

test('going back to automatic hands back the choosing', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce(LADDER, 1080)

  press('480p')
  await settle()
  press('自動')
  await settle()

  expect(player.level).toBe(AUTO_LEVEL)
})

test('the next lesson starts from automatic again', async () => {
  /** A different lesson is a different encode with its own ladder, and rung 2
   *  of the last one means nothing here — on a video with two rungs it is not
   *  even a rung. Carrying the choice forward would also follow somebody
   *  through a whole course on a decision they made about one video. */
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce(LADDER, 1080)

  press('480p')
  await settle()
  expect(player.level).toBe(0)

  ;[...container.querySelectorAll<HTMLButtonElement>('.learn-actions button')]
    .find((button) => (button.textContent ?? '').includes('下一單元'))!
    .click()
  await settle()

  expect(player.level).toBe(AUTO_LEVEL)
  expect(container.querySelector('.quality')).toBeNull()
})

test('the chosen rung is the one shown as chosen', async () => {
  render(<LearnPage slug="watercolour" />, container)
  await settle()
  await announce(LADDER, 1080)

  press('720p')
  await settle()

  const chosen = qualityButtons().filter((button) => button.getAttribute('aria-pressed') === 'true')
  expect(chosen.map((button) => button.textContent?.trim())).toEqual(['720p'])
})
