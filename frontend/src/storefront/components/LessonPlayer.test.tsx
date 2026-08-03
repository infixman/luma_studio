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

// The real player loads hls.js and reports the ladder from inside it. Kept
// here so a test can be the manifest: hand the mock a ladder the way hls.js
// would announce one, and read back which rung the bar asked for.
interface PlayerProps {
  mediaRef?: { current: HTMLVideoElement | null }
  controls?: boolean
  level?: number
  onRenditions?: (renditions: { index: number; height: number }[]) => void
  onPlayingRendition?: (height: number | null) => void
}

let player: PlayerProps = {}

vi.mock('../../shared/components/HlsVideo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/components/HlsVideo')>()),
  HlsVideo: (props: PlayerProps) => {
    player = props
    return (
      <video
        controls={props.controls}
        ref={(element) => {
          if (props.mediaRef) props.mediaRef.current = element
        }}
      />
    )
  },
}))

import { AUTO_LEVEL } from '../../shared/components/HlsVideo'
import { IDLE_HIDE_MS, LessonPlayer } from './LessonPlayer'

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
  vi.useRealTimers()
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

function shell(): HTMLDivElement {
  return container.querySelector<HTMLDivElement>('.lesson-player')!
}

function key(value: string, target: HTMLElement = shell()): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}

function volumeSlider(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.player-volume')!
}

/** What the browser does: change the property, then announce it. */
function media(
  values: Partial<Record<'duration' | 'currentTime' | 'volume' | 'muted', number | boolean>>,
  event?: string,
): void {
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

/**
 * The gear.
 *
 * Quality used to be a row of pills floating under the player, on
 * `LearnPage`, wherever the ladder happened to land — outside the bar
 * entirely and gone the moment there was nowhere obvious to put it. It moves
 * into the bar itself now, behind one gear, with playback speed alongside it:
 * a root menu of two rows, each opening onto its own list of choices, the
 * shape YouTube already taught everybody.
 */

const LADDER = [
  { index: 0, height: 480 },
  { index: 1, height: 720 },
  { index: 2, height: 1080 },
]

function menu(): HTMLElement | null {
  return container.querySelector('.player-menu')
}

function menuRow(label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('.player-menu-row')].find((row) =>
    (row.textContent ?? '').includes(label),
  ) ?? null
}

function menuOption(label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('.player-menu-option')].find((option) =>
    (option.textContent ?? '').trim() === label,
  ) ?? null
}

async function announce(renditions: { index: number; height: number }[], playing: number | null = null) {
  player.onRenditions?.(renditions)
  player.onPlayingRendition?.(playing)
  await settle()
}

test('the menu is closed until the gear is asked for it', async () => {
  await mount()

  expect(menu()).toBeNull()

  button('設定')!.click()
  await settle()

  expect(menu()).not.toBeNull()
})

test('one rendition is not a ladder, so quality is left out of the menu', async () => {
  await mount()
  await announce([{ index: 0, height: 720 }], 720)

  button('設定')!.click()
  await settle()

  expect(menuRow('播放速度')).not.toBeNull()
  expect(menuRow('畫質')).toBeNull()
})

test('a real ladder earns quality its own row, reading what is actually playing', async () => {
  await mount()
  await announce(LADDER, 480)

  button('設定')!.click()
  await settle()

  expect(menuRow('畫質')?.textContent).toContain('自動 · 480p')
})

test('the ladder opens highest first, under an automatic default', async () => {
  await mount()
  await announce(LADDER, 1080)

  button('設定')!.click()
  await settle()
  menuRow('畫質')!.click()
  await settle()

  const options = [...container.querySelectorAll<HTMLButtonElement>('.player-menu-option')].map((option) =>
    (option.textContent ?? '').trim(),
  )
  expect(options).toEqual(['自動 · 1080p', '1080p', '720p', '480p'])
})

test('picking a rung hands the player that index, by the ladder\'s own numbering', async () => {
  await mount()
  await announce(LADDER, 1080)

  button('設定')!.click()
  await settle()
  menuRow('畫質')!.click()
  await settle()
  menuOption('720p')!.click()
  await settle()

  // The player's own index, not the height — the two are not the same number
  // and the manifest decides the order.
  expect(player.level).toBe(1)
})

test('choosing a rung closes the menu behind it', async () => {
  await mount()
  await announce(LADDER, 1080)

  button('設定')!.click()
  await settle()
  menuRow('畫質')!.click()
  await settle()
  menuOption('720p')!.click()
  await settle()

  expect(menu()).toBeNull()
})

test('going back to automatic hands back the choosing', async () => {
  await mount()
  await announce(LADDER, 1080)

  button('設定')!.click()
  await settle()
  menuRow('畫質')!.click()
  await settle()
  menuOption('480p')!.click()
  await settle()

  button('設定')!.click()
  await settle()
  menuRow('畫質')!.click()
  await settle()
  menuOption('自動 · 1080p')!.click()
  await settle()

  expect(player.level).toBe(AUTO_LEVEL)
})

test('speed defaults to normal, not to the number 1', async () => {
  await mount()

  button('設定')!.click()
  await settle()

  expect(menuRow('播放速度')?.textContent).toContain('正常')
})

test('picking a speed sets it on the element and is read back on the row', async () => {
  await mount()

  button('設定')!.click()
  await settle()
  menuRow('播放速度')!.click()
  await settle()
  menuOption('1.5x')!.click()
  await settle()

  expect(video().playbackRate).toBe(1.5)

  button('設定')!.click()
  await settle()

  expect(menuRow('播放速度')?.textContent).toContain('1.5x')
})

test('the offered speeds run from half to double, normal in the middle', async () => {
  await mount()

  button('設定')!.click()
  await settle()
  menuRow('播放速度')!.click()
  await settle()

  const options = [...container.querySelectorAll<HTMLButtonElement>('.player-menu-option')].map((option) =>
    (option.textContent ?? '').trim(),
  )
  expect(options).toEqual(['0.5x', '0.75x', '正常', '1.25x', '1.5x', '2x'])
})

test('a click outside the menu closes it', async () => {
  await mount()
  button('設定')!.click()
  await settle()
  expect(menu()).not.toBeNull()

  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await settle()

  expect(menu()).toBeNull()
})

test('Escape closes the menu', async () => {
  await mount()
  button('設定')!.click()
  await settle()

  menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()

  expect(menu()).toBeNull()
})

/**
 * Volume and mute.
 *
 * The same rule as play and pause: the button and the slider read the
 * element back rather than a number kept beside it, so a change from
 * anywhere — the slider, a keyboard shortcut still to come, the element
 * starting out already muted — shows up the same way.
 */

test('the volume slider starts at whatever the element already has', async () => {
  await mount()
  media({ volume: 0.4 }, 'volumechange')
  await settle()

  expect(volumeSlider().value).toBe('0.4')
})

test('dragging the volume slider sets the element, not just the handle', async () => {
  await mount()

  volumeSlider().value = '0.2'
  volumeSlider().dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  expect(video().volume).toBe(0.2)
})

test('the mute button asks the element to mute', async () => {
  await mount()
  expect(button('靜音')).not.toBeNull()

  button('靜音')!.click()

  expect(video().muted).toBe(true)
})

test('the button follows the element back out of mute, not just into it', async () => {
  await mount()
  button('靜音')!.click()
  media({ muted: true }, 'volumechange')
  await settle()
  expect(button('取消靜音')).not.toBeNull()

  button('取消靜音')!.click()

  expect(video().muted).toBe(false)
})

test('the label follows the element, not the last button pressed', async () => {
  /** Muting can happen without this button — a keyboard shortcut still to
   *  come, or the element starting out already muted — and the label has to
   *  agree with whichever one did it. */
  await mount()
  media({ muted: true }, 'volumechange')
  await settle()

  expect(button('取消靜音')).not.toBeNull()
  expect(button('靜音')).toBeNull()
})

/**
 * Theatre mode.
 *
 * Not remembered — every mount starts out of it, same as playback speed —
 * because a mount is a fresh lesson and a member should not have to fight
 * their way back out of a layout they never chose for this one.
 *
 * The player only owns the flag and says so; widening itself and collapsing
 * whatever sits beside it is the page's layout, not the player's video.
 */

test('theatre mode starts off', async () => {
  await mount()

  expect(button('劇院模式')).not.toBeNull()
  expect(container.querySelector('.lesson-player')?.classList.contains('is-theater')).toBe(false)
})

test('the theatre button turns it on, and back off', async () => {
  await mount()

  button('劇院模式')!.click()
  await settle()

  expect(container.querySelector('.lesson-player')?.classList.contains('is-theater')).toBe(true)
  expect(button('結束劇院模式')).not.toBeNull()

  button('結束劇院模式')!.click()
  await settle()

  expect(container.querySelector('.lesson-player')?.classList.contains('is-theater')).toBe(false)
  expect(button('劇院模式')).not.toBeNull()
})

test('the page is told when theatre mode changes, not just the player', async () => {
  const onTheaterChange = vi.fn()
  render(
    <LessonPlayer src="https://api.example.test/course-media/a/1/master.m3u8" onTheaterChange={onTheaterChange} />,
    container,
  )
  await settle()

  button('劇院模式')!.click()
  await settle()

  expect(onTheaterChange).toHaveBeenCalledWith(true)

  button('結束劇院模式')!.click()
  await settle()

  expect(onTheaterChange).toHaveBeenCalledWith(false)
})

/**
 * Keyboard shortcuts.
 *
 * Scoped to the player itself, not the document: the shortcuts share letters
 * with things a page can reasonably contain elsewhere, and a global listener
 * would fire from anywhere on the page rather than from the video somebody is
 * actually watching.
 *
 * Every one of these dispatches through the same handlers the buttons call —
 * there is no second copy of "what does mute mean" to drift from the first.
 */

test('space and K both play and pause', async () => {
  await mount()

  key(' ')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce()

  video().dispatchEvent(new Event('play'))
  await settle()
  key('k')
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce()
})

test('the arrows seek five seconds at a time', async () => {
  await mount()
  media({ duration: 175, currentTime: 60 }, 'durationchange')
  await settle()

  key('ArrowRight')
  expect(video().currentTime).toBe(65)

  key('ArrowLeft')
  expect(video().currentTime).toBe(60)
})

test('seeking does not run past either end', async () => {
  await mount()
  media({ duration: 175, currentTime: 2 }, 'durationchange')
  await settle()

  key('ArrowLeft')
  expect(video().currentTime).toBe(0)

  media({ currentTime: 173 })
  key('ArrowRight')
  expect(video().currentTime).toBe(175)
})

test('up and down nudge the volume', async () => {
  await mount()
  media({ volume: 0.5 }, 'volumechange')
  await settle()

  key('ArrowUp')
  expect(video().volume).toBeCloseTo(0.55)

  key('ArrowDown')
  key('ArrowDown')
  expect(video().volume).toBeCloseTo(0.45)
})

test('M mutes and unmutes', async () => {
  await mount()

  key('m')
  expect(video().muted).toBe(true)

  key('m')
  expect(video().muted).toBe(false)
})

test('F asks for full screen the same as the button', async () => {
  await mount()

  key('f')
  await settle()

  expect(Element.prototype.requestFullscreen).toHaveBeenCalled()
})

test('T enters theatre mode the same as the button', async () => {
  await mount()

  key('t')
  await settle()

  expect(shell().classList.contains('is-theater')).toBe(true)
})

test('a shortcut typed into the volume slider is left to the slider', async () => {
  /** Otherwise pressing Left to nudge the volume down one native step also
   *  rewinds the video five seconds, because both handlers saw the same key. */
  await mount()
  media({ duration: 175, currentTime: 60 }, 'durationchange')
  await settle()

  key('ArrowLeft', volumeSlider())

  expect(video().currentTime).toBe(60)
})

/**
 * Idle auto-hide.
 *
 * A control bar sitting over the picture for the whole of a lesson is a
 * control bar in the way of it. It only earns the right to disappear while
 * something is actually playing and nobody has touched anything for a
 * while — paused, or with the settings menu open over it, it stays.
 *
 * Real time, not fake timers: preact schedules its re-render and effect
 * flush through requestAnimationFrame, and advancing a faked clock does not
 * reliably pump that queue in happy-dom. The delay is genuinely waited out
 * instead — slower, but it is testing the real scheduling rather than a
 * second, separate idea of what "later" means.
 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function idle(): boolean {
  return shell().classList.contains('is-idle')
}

test('the bar starts visible', async () => {
  await mount()

  expect(idle()).toBe(false)
})

test('playing and leaving it alone hides the bar after a while', async () => {
  await mount()

  video().dispatchEvent(new Event('play'))
  await wait(IDLE_HIDE_MS + 200)

  expect(idle()).toBe(true)
}, 10_000)

test('a paused video never hides its own controls', async () => {
  await mount()

  await wait(IDLE_HIDE_MS + 200)

  expect(idle()).toBe(false)
}, 10_000)

test('moving the mouse wakes it back up', async () => {
  await mount()
  video().dispatchEvent(new Event('play'))
  await wait(IDLE_HIDE_MS + 200)
  expect(idle()).toBe(true)

  shell().dispatchEvent(new Event('mousemove', { bubbles: true }))
  await settle()

  expect(idle()).toBe(false)
}, 10_000)

test('a touch counts as movement too', async () => {
  await mount()
  video().dispatchEvent(new Event('play'))
  await wait(IDLE_HIDE_MS + 200)
  expect(idle()).toBe(true)

  shell().dispatchEvent(new Event('touchstart', { bubbles: true }))
  await settle()

  expect(idle()).toBe(false)
}, 10_000)

test('stopping shows the bar back immediately, not after the delay runs out', async () => {
  await mount()
  video().dispatchEvent(new Event('play'))
  await wait(IDLE_HIDE_MS + 200)
  expect(idle()).toBe(true)

  video().dispatchEvent(new Event('pause'))
  await settle()

  expect(idle()).toBe(false)
}, 10_000)

test('an open settings menu holds the bar open, even while playing', async () => {
  await mount()
  video().dispatchEvent(new Event('play'))
  await settle()

  button('設定')!.click()
  await wait(IDLE_HIDE_MS + 200)

  expect(idle()).toBe(false)
}, 10_000)

/**
 * Played and buffered, painted onto the track.
 *
 * Firefox fills the played portion on its own once `value` moves —
 * `::-moz-range-progress` already does that, native. WebKit has no such
 * pseudo-element at all, so both the played fraction and how much is
 * buffered ahead of it are pushed onto the input as CSS custom properties
 * and painted by a gradient on `::-webkit-slider-runnable-track` in
 * lesson-player.css. The properties are what a test can actually see —
 * the gradient itself is CSS, not something happy-dom renders.
 */

function timeRanges(ranges: [number, number][]) {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index]![0],
    end: (index: number) => ranges[index]![1],
  }
}

function customProperty(name: string): string {
  return scrubber().style.getPropertyValue(name)
}

test('the played fraction is exposed as a custom property', async () => {
  await mount()
  media({ duration: 100 }, 'durationchange')
  media({ currentTime: 25 }, 'timeupdate')
  await settle()

  expect(customProperty('--played')).toBe('25%')
})

test('nothing buffered yet paints nothing buffered', async () => {
  await mount()
  media({ duration: 100 }, 'durationchange')
  await settle()

  expect(customProperty('--buffered')).toBe('0%')
})

test('a reported buffer range becomes a custom property too', async () => {
  await mount()
  media({ duration: 100, currentTime: 10 }, 'durationchange')
  Object.defineProperty(video(), 'buffered', { value: timeRanges([[0, 80]]), configurable: true })
  video().dispatchEvent(new Event('progress'))
  await settle()

  expect(customProperty('--buffered')).toBe('80%')
})

test('a length nobody knows yet paints nothing rather than a guess', async () => {
  /** duration is NaN before the metadata lands, and 25 / NaN is itself NaN —
   *  a percentage that would paint the whole track as "played". */
  await mount()

  expect(customProperty('--played')).toBe('0%')
  expect(customProperty('--buffered')).toBe('0%')
})
