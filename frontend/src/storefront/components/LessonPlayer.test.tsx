// @vitest-environment happy-dom

/**
 * A control bar of our own.
 *
 * The browser's bar cannot show a quality menu — hls.js feeds the element
 * through MSE, so the browser does not know a ladder exists — and it cannot be
 * asked to hold a theatre-mode button either. So the storefront draws its own
 * and the native one stands down.
 *
 * The scrubber is a real `<input type="range">`. Dragging, keyboard, and the
 * whole of the accessibility contract come with it, and hand-rolling a seek
 * bar is the part of this job most likely to end up worse than what it
 * replaced.
 *
 * happy-dom has no playback: nothing advances, `play()` resolves without
 * anything happening, and `duration` is whatever the test says it is. So the
 * element is driven the way the browser would drive it — set the property,
 * fire the event — and what is asserted is that the bar reflects it.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('../../shared/components/HlsVideo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/components/HlsVideo')>()),
  HlsVideo: ({ mediaRef, controls }: { mediaRef?: { current: HTMLVideoElement | null }; controls?: boolean }) => (
    <video
      controls={controls}
      ref={(element) => {
        if (mediaRef) mediaRef.current = element
      }}
    />
  ),
}))

import { LessonPlayer } from './LessonPlayer'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  HTMLMediaElement.prototype.play = vi.fn(async () => {})
  HTMLMediaElement.prototype.pause = vi.fn()
  Element.prototype.requestFullscreen = vi.fn(async () => {})
  document.exitFullscreen = vi.fn(async () => {})
})

afterEach(() => {
  render(null, container)
  container.remove()
  vi.restoreAllMocks()
})

async function settle() {
  for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function video(): HTMLVideoElement {
  return container.querySelector('video')!
}

function button(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}

function scrubber(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.player-scrub')!
}

/** What the browser does: change the property, then announce it. */
function media(values: Partial<Record<'duration' | 'currentTime', number>>, event?: string): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(video(), name, { value, configurable: true, writable: true })
  }
  if (event) video().dispatchEvent(new Event(event))
}

async function mount() {
  render(<LessonPlayer src="https://api.example.test/course-media/a/1/master.m3u8" />, container)
  await settle()
}

test('the browser draws no bar of its own', async () => {
  /** Two bars over one video disagree about it, and the lower one is the one
   *  nobody asked for. */
  await mount()

  expect(video().hasAttribute('controls')).toBe(false)
})

test('a stopped video offers to play, and a playing one offers to stop', async () => {
  await mount()

  expect(button('播放')).not.toBeNull()

  button('播放')!.click()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()

  // The button follows the element, not the click: playback can start and stop
  // without anybody pressing anything.
  video().dispatchEvent(new Event('play'))
  await settle()

  expect(button('暫停')).not.toBeNull()
  expect(button('播放')).toBeNull()
})

test('pausing asks the element to pause', async () => {
  await mount()
  video().dispatchEvent(new Event('play'))
  await settle()

  button('暫停')!.click()

  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
})

test('the scrubber spans the video once its length is known', async () => {
  await mount()

  // Before the metadata lands there is no length to span.
  expect(scrubber().max).toBe('0')

  media({ duration: 175 }, 'durationchange')
  await settle()

  expect(scrubber().max).toBe('175')
})

test('the bar reads the position off the element as it advances', async () => {
  await mount()
  media({ duration: 175 }, 'durationchange')
  media({ currentTime: 62 }, 'timeupdate')
  await settle()

  expect(scrubber().value).toBe('62')
  expect(container.querySelector('.player-time')?.textContent).toBe('1:02 / 2:55')
})

test('dragging the scrubber moves the video, not just the handle', async () => {
  await mount()
  media({ duration: 175 }, 'durationchange')
  await settle()

  scrubber().value = '90'
  scrubber().dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  expect(video().currentTime).toBe(90)
})

test('a length that is not known yet is not drawn as a length', async () => {
  /** duration is NaN until the metadata arrives; 0:00 / 0:00 under a video
   *  that is loading reads as a video of no length. */
  await mount()

  expect(container.querySelector('.player-time')?.textContent).toBe('0:00 / --:--')
})

test('full screen is asked of the whole player, not of the video', async () => {
  /** The bar has to come with it. Asking the video element alone gives the
   *  browser's own overlay back and leaves our controls behind on the page. */
  await mount()

  button('全螢幕')!.click()
  await settle()

  expect(Element.prototype.requestFullscreen).toHaveBeenCalled()
  const asked = vi.mocked(Element.prototype.requestFullscreen).mock.instances[0]
  expect(asked).toBe(container.querySelector('.lesson-player'))
})

test('leaving full screen is offered while in it, and asked of the document', async () => {
  await mount()

  Object.defineProperty(document, 'fullscreenElement', {
    value: container.querySelector('.lesson-player'),
    configurable: true,
  })
  document.dispatchEvent(new Event('fullscreenchange'))
  await settle()

  expect(button('全螢幕')).toBeNull()
  button('離開全螢幕')!.click()

  expect(document.exitFullscreen).toHaveBeenCalled()
})
