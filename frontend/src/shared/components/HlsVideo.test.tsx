// @vitest-environment happy-dom

/**
 * The player, and the one thing it must not do: restart itself.
 *
 * Both pages that use it re-render on a timer — the library polls every three
 * seconds, the learn page renews its playback session — and every re-render
 * passes freshly-created callback props. When those were effect dependencies
 * the effect tore the player down and built it again on each one, which looks
 * like a video that loads, vanishes, loads, vanishes.
 *
 * Choosing a rendition is the same rule wearing a different hat: the choice is
 * pushed into the player that is already running, so the picture changes and
 * the video carries on from where it was.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

interface FakePlayer {
  src: string | null
  destroyed: boolean
  currentLevel: number
  /** Push an hls.js event at the component, as the real one would. */
  fire(event: string, data?: unknown): void
}

const built: FakePlayer[] = []

/** What a master playlist offers, lowest first — the order hls.js reports. */
const LADDER = [{ height: 480 }, { height: 720 }, { height: 1080 }]

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = {
      ERROR: 'hlsError',
      MANIFEST_PARSED: 'hlsManifestParsed',
      LEVEL_SWITCHED: 'hlsLevelSwitched',
    }
    static isSupported = () => true
    src: string | null = null
    destroyed = false
    currentLevel = -1
    levels = LADDER
    private listeners = new Map<string, (event: string, data: unknown) => void>()
    constructor() {
      built.push(this)
    }
    on(event: string, listener: (event: string, data: unknown) => void) {
      this.listeners.set(event, listener)
    }
    fire(event: string, data: unknown = {}) {
      this.listeners.get(event)?.(event, data)
    }
    loadSource(src: string) {
      this.src = src
    }
    attachMedia() {}
    destroy() {
      this.destroyed = true
    }
  }
  return { default: FakeHls }
})

import { HlsVideo, type HlsRendition } from './HlsVideo'

let container: HTMLDivElement

beforeEach(async () => {
  built.length = 0
  container = document.createElement('div')
  document.body.append(container)
  // happy-dom's video element answers this for everything. It no longer
  // decides which path is taken, but leaving it honest keeps the tests about
  // one thing at a time.
  HTMLMediaElement.prototype.canPlayType = () => ''
  // The fake is a module singleton, so a test that turns MSE off has to hand
  // it back — otherwise every test after it silently runs on the iOS path.
  const hls = (await import('hls.js')).default as unknown as { isSupported: () => boolean }
  hls.isSupported = () => true
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Whose controls.
 *
 * The back office wants the browser's — it is a tool, the person using it is
 * checking that a transcode came out right, and the native bar is the one
 * every browser already knows how to make accessible. The storefront is
 * building its own, and a native bar underneath it would be two sets of
 * controls disagreeing about the same video.
 *
 * Native is therefore the default: adding a prop must not quietly change what
 * every existing caller gets.
 */
test('the browser draws the controls unless asked otherwise', async () => {
  render(<HlsVideo src="/media/master.m3u8" />, container)
  await settle()

  expect(container.querySelector('video')?.hasAttribute('controls')).toBe(true)
})

test('a caller drawing its own gets a bare video', async () => {
  render(<HlsVideo src="/media/master.m3u8" controls={false} />, container)
  await settle()

  expect(container.querySelector('video')?.hasAttribute('controls')).toBe(false)
})

test('the element is handed to a caller that asks for it', async () => {
  /** A control bar of one's own has nothing to control without it: play,
   *  pause, seek and volume all live on the element, not on this component. */
  const media: { current: HTMLVideoElement | null } = { current: null }

  render(<HlsVideo src="/media/master.m3u8" controls={false} mediaRef={media} />, container)
  await settle()

  expect(media.current).toBe(container.querySelector('video'))
})

/**
 * Who plays it, when both could.
 *
 * This used to hand the URL straight to the element whenever
 * `canPlayType('application/vnd.apple.mpegurl')` said anything at all. The
 * comment said Safari and iOS, and when it was written that was who answered.
 * Edge on Windows now answers `maybe` — it really can play HLS — so the
 * storefront took the native path, hls.js was never loaded, and the ladder was
 * never reported. The quality control had nothing to list and drew nothing,
 * on a video with three renditions in its manifest.
 *
 * A browser playing HLS by itself does not say what rungs exist and cannot be
 * asked to change rung. So MSE wins wherever it exists, and native is the
 * fallback rather than the preference — iOS, where `isSupported` is false
 * because there is no MSE at all.
 */
test('a browser that could play it natively still gets hls.js', async () => {
  HTMLMediaElement.prototype.canPlayType = () => 'maybe'
  const renditions: HlsRendition[][] = []

  render(<HlsVideo src="/media/master.m3u8" onRenditions={(list) => renditions.push(list)} />, container)
  await settle()
  built[0]!.fire('hlsManifestParsed')

  expect(built).toHaveLength(1)
  expect(container.querySelector('video')?.getAttribute('src')).toBeNull()
  expect(renditions[0]).toEqual([
    { index: 0, height: 480 },
    { index: 1, height: 720 },
    { index: 2, height: 1080 },
  ])
})

test('a re-render with new callbacks does not rebuild the player', async () => {
  render(<HlsVideo src="/media/master.m3u8" onError={() => {}} />, container)
  await settle()
  expect(built).toHaveLength(1)

  // What a poll does: same video, brand-new function identities.
  render(<HlsVideo src="/media/master.m3u8" onError={() => {}} />, container)
  await settle()

  expect(built).toHaveLength(1)
  expect(built[0]!.destroyed).toBe(false)
})

test('a different video does rebuild the player', async () => {
  render(<HlsVideo src="/media/one.m3u8" />, container)
  await settle()

  render(<HlsVideo src="/media/two.m3u8" />, container)
  await settle()

  expect(built.map((entry) => entry.src)).toEqual(['/media/one.m3u8', '/media/two.m3u8'])
  expect(built[0]!.destroyed).toBe(true)
})

test('unmounting takes the player with it', async () => {
  render(<HlsVideo src="/media/master.m3u8" />, container)
  await settle()

  render(null, container)
  await settle()

  expect(built[0]!.destroyed).toBe(true)
})

test('the renditions are the ones the manifest names, not a ladder we assumed', async () => {
  /** The encode ladder is a property of the transcode, and the transcode is the
   *  thing under inspection. A list written out here would keep showing three
   *  rungs after the ladder changed. */
  const reported: HlsRendition[][] = []
  render(<HlsVideo src="/media/master.m3u8" onRenditions={(list) => reported.push(list)} />, container)
  await settle()

  built[0]!.fire('hlsManifestParsed')

  expect(reported).toEqual([
    [
      { index: 0, height: 480 },
      { index: 1, height: 720 },
      { index: 2, height: 1080 },
    ],
  ])
})

test('it reports which rendition is actually on screen', async () => {
  /** In automatic mode this is the only way to know. Nothing else says which
   *  rung the picture came from, and on a fast connection it is always the top
   *  one — which is exactly how a broken 480p goes unnoticed. */
  const playing: (number | null)[] = []
  render(<HlsVideo src="/media/master.m3u8" onPlayingRendition={(height) => playing.push(height)} />, container)
  await settle()

  built[0]!.fire('hlsLevelSwitched', { level: 1 })
  built[0]!.fire('hlsLevelSwitched', { level: 2 })

  expect(playing).toEqual([720, 1080])
})

test('choosing a rendition switches the running player rather than rebuilding it', async () => {
  /** Rebuilding would take the video back to the beginning, so the one thing an
   *  admin is trying to look at closely is the one thing they would lose. */
  render(<HlsVideo src="/media/master.m3u8" level={-1} />, container)
  await settle()

  render(<HlsVideo src="/media/master.m3u8" level={2} />, container)
  await settle()

  expect(built).toHaveLength(1)
  expect(built[0]!.destroyed).toBe(false)
  expect(built[0]!.currentLevel).toBe(2)
})

test('native playback names no renditions, because nothing there can switch them', async () => {
  /** iOS. The element plays the manifest itself, hls.js is never loaded, and
   *  there is no level to set — so no ladder is reported, and a caller that
   *  shows its control only once renditions arrive shows none rather than one
   *  that does nothing.
   *
   *  This used to be triggered by `canPlayType` alone, which is what put the
   *  storefront on this path in Edge and cost it the quality control
   *  altogether. The trigger is the absence of MSE now, which is the thing
   *  that actually decides whether hls.js can run. */
  const hls = (await import('hls.js')).default as unknown as { isSupported: () => boolean }
  hls.isSupported = () => false
  HTMLMediaElement.prototype.canPlayType = () => 'maybe'
  const reported: HlsRendition[][] = []

  render(<HlsVideo src="/media/master.m3u8" onRenditions={(list) => reported.push(list)} />, container)
  await settle()

  expect(built).toHaveLength(0)
  expect(reported).toEqual([])
  expect(container.querySelector('video')?.getAttribute('src')).toBe('/media/master.m3u8')
})
