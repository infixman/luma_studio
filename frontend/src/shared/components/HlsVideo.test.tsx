// @vitest-environment happy-dom

/**
 * The player, and the one thing it must not do: restart itself.
 *
 * Both pages that use it re-render on a timer — the library polls every three
 * seconds, the learn page renews its playback session — and every re-render
 * passes freshly-created callback props. When those were effect dependencies
 * the effect tore the player down and built it again on each one, which looks
 * like a video that loads, vanishes, loads, vanishes.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const built: { src: string | null; destroyed: boolean }[] = []

vi.mock('hls.js', () => {
  class FakeHls {
    static Events = { ERROR: 'hlsError' }
    static isSupported = () => true
    private entry = { src: null as string | null, destroyed: false }
    constructor() {
      built.push(this.entry)
    }
    on() {}
    loadSource(src: string) {
      this.entry.src = src
    }
    attachMedia() {}
    destroy() {
      this.entry.destroyed = true
    }
  }
  return { default: FakeHls }
})

import { HlsVideo } from './HlsVideo'

let container: HTMLDivElement

beforeEach(() => {
  built.length = 0
  container = document.createElement('div')
  document.body.append(container)
  // happy-dom's video element answers this for everything, which would take
  // the native path and never reach hls.js.
  HTMLMediaElement.prototype.canPlayType = () => ''
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

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
