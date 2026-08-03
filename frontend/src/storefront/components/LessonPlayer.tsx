import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { HlsVideo } from '../../shared/components/HlsVideo'
import type { HlsRendition } from '../../shared/components/HlsVideo'
import { clock } from '../lib/clock'
import '../styles/lesson-player.css'

/**
 * The lesson player, with a control bar of the storefront's own.
 *
 * The browser's bar cannot show a quality menu — hls.js feeds the element
 * through MSE, so the browser has no idea a ladder exists — and there is
 * nowhere in it to put a theatre-mode button. So it stands down and this draws
 * the bar instead.
 *
 * The scrubber is a real `<input type="range">` rather than a div with a drag
 * handler. Pointer capture, touch, keyboard, and the whole of the
 * accessibility contract arrive with it, and a hand-rolled seek bar is the
 * part of this job most likely to come out worse than the thing it replaced.
 *
 * Everything shown is read back off the element rather than remembered here.
 * Playback starts and stops without anybody pressing anything — the end of a
 * video, a phone call, another tab taking the audio — and a bar that trusts
 * its own last instruction ends up saying "pause" over a stopped video.
 */
export function LessonPlayer({
  src,
  level,
  onRenditions,
  onPlayingRendition,
  onPosition,
  onEnded,
  onError,
}: {
  src: string
  level?: number
  onRenditions?: (renditions: HlsRendition[]) => void
  onPlayingRendition?: (height: number | null) => void
  onPosition?: (seconds: number) => void
  onEnded?: () => void
  onError?: () => void
}) {
  const media = useRef<HTMLVideoElement | null>(null)
  const shell = useRef<HTMLDivElement>(null)

  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(Number.NaN)
  const [fullscreen, setFullscreen] = useState(false)

  // Bound to the element, because the element is where the truth is.
  //
  // Each event does what it means rather than every event re-reading
  // everything: `paused` is a snapshot, and reading it during a `play` event
  // asks the element a question it is in the middle of answering. The events
  // are the signal — `play` means playing whatever the property says at that
  // instant. `loadedmetadata` and `durationchange` both carry a length; which
  // arrives first is the browser's business.
  useEffect(() => {
    const element = media.current
    if (!element) return

    const started = () => setPlaying(true)
    const stopped = () => setPlaying(false)
    const moved = () => setPosition(element.currentTime)
    const measured = () => setDuration(element.duration)

    const bindings: [string, () => void][] = [
      ['play', started],
      ['playing', started],
      ['pause', stopped],
      ['ended', stopped],
      ['timeupdate', moved],
      ['seeked', moved],
      ['durationchange', measured],
      ['loadedmetadata', measured],
    ]

    for (const [name, listener] of bindings) element.addEventListener(name, listener)

    // Whatever it already is, for a player mounted onto a running element.
    setPlaying(!element.paused && !element.ended)
    moved()
    measured()

    return () => {
      for (const [name, listener] of bindings) element.removeEventListener(name, listener)
    }
  }, [src])

  // Owned by the document, not by the button: Escape and F11 leave full screen
  // without going anywhere near it.
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === shell.current)
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  // From the same state that draws the label, not from `paused`. The button
  // has to do what it says, and a label read from one source with an action
  // read from another is two answers to one question.
  const toggle = useCallback(() => {
    const element = media.current
    if (!element) return
    if (playing) element.pause()
    else void element.play()
  }, [playing])

  const seek = useCallback((seconds: number) => {
    const element = media.current
    if (!element) return
    element.currentTime = seconds
    // The element will announce this, but not before the next frame, and a
    // handle that lags the finger dragging it feels broken.
    setPosition(seconds)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === shell.current) void document.exitFullscreen()
    else void shell.current?.requestFullscreen()
  }, [])

  const known = Number.isFinite(duration)

  return (
    <div class="lesson-player" ref={shell}>
      <HlsVideo
        src={src}
        controls={false}
        mediaRef={media}
        level={level}
        onRenditions={onRenditions}
        onPlayingRendition={onPlayingRendition}
        onPosition={onPosition}
        onEnded={onEnded}
        onError={onError}
      />

      <div class="player-bar">
        <button type="button" aria-label={playing ? '暫停' : '播放'} onClick={toggle}>
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>

        <input
          class="player-scrub"
          type="range"
          min={0}
          // Zero rather than a guess: an unknown length must not let somebody
          // drag to a position the video does not have.
          max={known ? duration : 0}
          step="any"
          value={position}
          aria-label="播放進度"
          aria-valuetext={clock(position)}
          onInput={(event) => seek(Number((event.currentTarget as HTMLInputElement).value))}
        />

        <span class="player-time">
          {clock(position)} / {clock(duration)}
        </span>

        <button
          type="button"
          aria-label={fullscreen ? '離開全螢幕' : '全螢幕'}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <ShrinkGlyph /> : <ExpandGlyph />}
        </button>
      </div>
    </div>
  )
}

/* Drawn rather than lettered: a control bar's buttons are the one place a
   glyph is read faster than a word, and these four are the ones every player
   has taught everybody already. */

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  )
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" />
    </svg>
  )
}

function ExpandGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
    </svg>
  )
}

function ShrinkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
    </svg>
  )
}
