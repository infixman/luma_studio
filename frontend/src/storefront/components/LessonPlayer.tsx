import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AUTO_LEVEL, HlsVideo } from '../../shared/components/HlsVideo'
import type { HlsRendition } from '../../shared/components/HlsVideo'
import { clock } from '../lib/clock'
import '../styles/lesson-player.css'

/** Playback speeds on offer, half to double with normal in the middle —
 *  the range every player converges on because it is the one that stays
 *  intelligible at both ends. */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

function speedLabel(speed: number): string {
  return speed === 1 ? '正常' : `${speed}x`
}

type MenuPane = 'closed' | 'root' | 'speed' | 'quality'

/** How long the pointer can sit still, mid-playback, before the bar gets out
 *  of the way of the picture it is sitting on. */
export const IDLE_HIDE_MS = 3000

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
  onPosition,
  onEnded,
  onError,
  onTheaterChange,
  autoplay,
  onAutoplayChange,
}: {
  src: string
  onPosition?: (seconds: number) => void
  onEnded?: () => void
  onError?: () => void
  /** Whether the end of this video should run on into whatever comes after
   *  it. The switch is here because this is where the controls are; what
   *  "after" means is the page's, and so is acting on it. Left out entirely
   *  when nothing owns the answer, and then the row is not drawn. */
  autoplay?: boolean
  onAutoplayChange?: (next: boolean) => void
  /** Widening the player and collapsing whatever sits beside it is the
   *  page's layout, not the video's — this only says the flag changed. */
  onTheaterChange?: (active: boolean) => void
}) {
  const media = useRef<HTMLVideoElement | null>(null)
  const shell = useRef<HTMLDivElement>(null)
  const settings = useRef<HTMLDivElement>(null)

  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(Number.NaN)
  const [fullscreen, setFullscreen] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [theater, setTheater] = useState(false)
  const [bufferedEnd, setBufferedEnd] = useState(0)

  // The ladder the manifest turned out to have, which rung the member asked
  // for, and which one hls.js is actually serving — the last is worth keeping
  // because it is the answer to "why does this look soft"; without it
  // 「自動」 is a word that explains nothing.
  const [renditions, setRenditions] = useState<HlsRendition[]>([])
  const [level, setLevel] = useState(AUTO_LEVEL)
  const [playingHeight, setPlayingHeight] = useState<number | null>(null)
  const [rate, setRate] = useState(1)
  const [menu, setMenu] = useState<MenuPane>('closed')
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    const volumed = () => {
      setVolume(element.volume)
      setMuted(element.muted)
    }
    // The end of whichever buffered range currently holds the playhead —
    // that range is the one that answers "how much further can this play
    // right now", not necessarily the last one the network has fetched.
    const buffered = () => {
      const ranges = element.buffered
      let end = 0
      for (let index = 0; index < ranges.length; index++) {
        if (ranges.start(index) <= element.currentTime && element.currentTime <= ranges.end(index)) {
          end = ranges.end(index)
          break
        }
      }
      setBufferedEnd(end)
    }

    const bindings: [string, () => void][] = [
      ['play', started],
      ['playing', started],
      ['pause', stopped],
      ['ended', stopped],
      ['timeupdate', moved],
      ['seeked', moved],
      ['durationchange', measured],
      ['loadedmetadata', measured],
      ['volumechange', volumed],
      ['progress', buffered],
    ]

    for (const [name, listener] of bindings) element.addEventListener(name, listener)

    // Whatever it already is, for a player mounted onto a running element.
    setPlaying(!element.paused && !element.ended)
    moved()
    measured()
    volumed()
    buffered()

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

  // Pushed onto the element whenever it changes, not just at the point it is
  // chosen — the element is what actually plays at a rate, this is only where
  // the number is remembered.
  useEffect(() => {
    const element = media.current
    if (element) element.playbackRate = rate
  }, [rate])

  // A menu open over a video is a menu somebody expects to dismiss without
  // hunting for the one control that opened it.
  useEffect(() => {
    if (menu === 'closed') return
    const outside = (event: PointerEvent) => {
      if (!settings.current?.contains(event.target as Node)) setMenu('closed')
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu])

  // Only earns the right to disappear while something is actually playing
  // and the settings menu is not open over it — a paused video is a video
  // somebody is likely about to act on, and a menu with no bar under it has
  // nothing to anchor to.
  const wake = useCallback(() => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    if (playing && menu === 'closed') {
      idleTimer.current = setTimeout(() => setIdle(true), IDLE_HIDE_MS)
    }
  }, [playing, menu])

  useEffect(() => {
    wake()
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [wake])

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

  const toggleMute = useCallback(() => {
    const element = media.current
    if (!element) return
    element.muted = !element.muted
    setMuted(element.muted)
  }, [])

  const changeVolume = useCallback((value: number) => {
    const element = media.current
    if (!element) return
    element.volume = value
    setVolume(value)
    // Asking for a level is asking to hear it. Moving the handle while muted
    // would otherwise set a volume nobody can hear and leave the slider and
    // the silence disagreeing.
    if (value > 0 && element.muted) {
      element.muted = false
      setMuted(false)
    }
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement === shell.current) {
      void document.exitFullscreen()
      return
    }

    // The whole player, so the bar comes with it.
    if (shell.current?.requestFullscreen) {
      void shell.current.requestFullscreen()
      return
    }

    // Except on the iPhone, where no element but a video can go fullscreen at
    // all — `requestFullscreen` is simply absent. The video goes on its own
    // and Safari's own controls come with it, which is the whole of what is
    // available there; the alternative is a button that does nothing.
    const element = media.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    element?.webkitEnterFullscreen?.()
  }, [])

  const toggleTheater = useCallback(() => {
    setTheater((active) => {
      const next = !active
      onTheaterChange?.(next)
      return next
    })
  }, [onTheaterChange])

  const seekBy = useCallback(
    (delta: number) => {
      const element = media.current
      if (!element) return
      const upper = Number.isFinite(duration) ? duration : Infinity
      seek(Math.max(0, Math.min(upper, element.currentTime + delta)))
    },
    [duration, seek],
  )

  const nudgeVolume = useCallback(
    (delta: number) => {
      const element = media.current
      if (!element) return
      changeVolume(Math.max(0, Math.min(1, element.volume + delta)))
    },
    [changeVolume],
  )

  // Scoped to the player, not the document: the letters here are ones a page
  // can reasonably use elsewhere, and a native form control already knows
  // what its own arrow keys mean — this defers to it rather than fighting it.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      wake()
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return

      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          event.preventDefault()
          toggle()
          break
        case 'ArrowLeft':
          event.preventDefault()
          seekBy(-5)
          break
        case 'ArrowRight':
          event.preventDefault()
          seekBy(5)
          break
        case 'ArrowUp':
          event.preventDefault()
          nudgeVolume(0.05)
          break
        case 'ArrowDown':
          event.preventDefault()
          nudgeVolume(-0.05)
          break
        case 'm':
        case 'M':
          toggleMute()
          break
        case 'f':
        case 'F':
          toggleFullscreen()
          break
        case 't':
        case 'T':
          toggleTheater()
          break
      }
    },
    [wake, toggle, seekBy, nudgeVolume, toggleMute, toggleFullscreen, toggleTheater],
  )

  const known = Number.isFinite(duration) && duration > 0
  // Firefox paints the played portion itself once `value` moves; WebKit has
  // no pseudo-element for it at all, so both this and how much is buffered
  // ahead of it are pushed on as custom properties for the track gradient in
  // lesson-player.css to read. 25 / NaN is itself NaN, so `known` gates both
  // rather than painting a percentage of a length nobody has measured yet.
  const playedPercent = known ? Math.min(100, (position / duration) * 100) : 0
  const bufferedPercent = known ? Math.min(100, (bufferedEnd / duration) * 100) : 0

  return (
    <div
      class={`lesson-player${theater ? ' is-theater' : ''}${idle ? ' is-idle' : ''}`}
      ref={shell}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={wake}
      onTouchStart={wake}
    >
      <HlsVideo
        src={src}
        controls={false}
        mediaRef={media}
        level={level}
        onRenditions={setRenditions}
        onPlayingRendition={setPlayingHeight}
        onPosition={onPosition}
        onEnded={onEnded}
        onError={onError}
      />

      <div class="player-bar">
        <Control label={playing ? '暫停' : '播放'} shortcut="k" onClick={toggle}>
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </Control>

        <div class="player-volume-group">
          <Control label={muted ? '取消靜音' : '靜音'} shortcut="m" onClick={toggleMute}>
            {muted || volume === 0 ? <MutedGlyph /> : <VolumeGlyph />}
          </Control>

          {/* Mute is a pause on the volume, not a way of setting it to
              nothing: the level is kept in state so the button can put it
              back. The handle shows what is being heard, which while muted
              is zero — a slider sitting at 0.8 over silence says the sound
              is on, and the handle is the part being looked at. */}
          <input
            class="player-volume"
            type="range"
            min={0}
            max={1}
            step="any"
            value={muted ? 0 : volume}
            aria-label="音量"
            onInput={(event) => changeVolume(Number((event.currentTarget as HTMLInputElement).value))}
          />
        </div>

        <input
          class="player-scrub"
          type="range"
          min={0}
          // Zero rather than a guess: an unknown length must not let somebody
          // drag to a position the video does not have.
          max={known ? duration : 0}
          step="any"
          value={position}
          style={{ '--played': `${playedPercent}%`, '--buffered': `${bufferedPercent}%` }}
          aria-label="播放進度"
          aria-valuetext={clock(position)}
          onInput={(event) => seek(Number((event.currentTarget as HTMLInputElement).value))}
        />

        <span class="player-time">
          {clock(position)} / {clock(duration)}
        </span>

        {/* On the bar rather than inside the gear. It is a setting somebody
            changes while watching — at the end of a lesson, when the next one
            starts and they did not want it to — and two taps into a menu is
            too far to reach for that. */}
        {onAutoplayChange && (
          <Control
            label={autoplay ? '已啟用自動播放功能' : '已停用自動播放功能'}
            pressed={autoplay === true}
            onClick={() => onAutoplayChange(!autoplay)}
          >
            <AutoplayGlyph on={autoplay === true} />
          </Control>
        )}

        <div class="player-settings" ref={settings}>
          {/* Not a Control: it owns a menu, so it carries the two ARIA
              attributes that say so, and its tooltip has to go while the
              menu it opened is over the same spot. */}
          <button
            type="button"
            aria-label="設定"
            aria-haspopup="menu"
            aria-expanded={menu !== 'closed'}
            onClick={() => setMenu(menu === 'closed' ? 'root' : 'closed')}
          >
            <GearGlyph />
            {menu === 'closed' && (
              <span class="player-tip" aria-hidden="true">
                設定
              </span>
            )}
          </button>

          {menu !== 'closed' && (
            <div
              class="player-menu"
              role="menu"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                setMenu('closed')
              }}
            >
              {menu === 'root' && (
                <>
                  <button type="button" class="player-menu-row" onClick={() => setMenu('speed')}>
                    <span>播放速度</span>
                    <span class="player-menu-value">{speedLabel(rate)}</span>
                  </button>
                  {renditions.length > 1 && (
                    <button type="button" class="player-menu-row" onClick={() => setMenu('quality')}>
                      <span>畫質</span>
                      <span class="player-menu-value">
                        {level === AUTO_LEVEL
                          ? playingHeight === null
                            ? '自動'
                            : `自動 · ${playingHeight}p`
                          : `${renditions.find((rendition) => rendition.index === level)?.height ?? ''}p`}
                      </span>
                    </button>
                  )}
                </>
              )}

              {menu === 'speed' && (
                <>
                  <button type="button" class="player-menu-back" onClick={() => setMenu('root')}>
                    ‹ 播放速度
                  </button>
                  {SPEEDS.map((speed) => (
                    <button
                      key={speed}
                      type="button"
                      class="player-menu-option"
                      aria-pressed={rate === speed}
                      onClick={() => {
                        setRate(speed)
                        setMenu('closed')
                      }}
                    >
                      {speedLabel(speed)}
                    </button>
                  ))}
                </>
              )}

              {menu === 'quality' && (
                <>
                  <button type="button" class="player-menu-back" onClick={() => setMenu('root')}>
                    ‹ 畫質
                  </button>
                  <button
                    type="button"
                    class="player-menu-option"
                    aria-pressed={level === AUTO_LEVEL}
                    onClick={() => {
                      setLevel(AUTO_LEVEL)
                      setMenu('closed')
                    }}
                  >
                    {playingHeight === null ? '自動' : `自動 · ${playingHeight}p`}
                  </button>
                  {/* Highest first: somebody who opens this wants the good one
                      and should not read to the end of the list. */}
                  {[...renditions]
                    .sort((a, b) => b.height - a.height)
                    .map((rendition) => (
                      <button
                        key={rendition.index}
                        type="button"
                        class="player-menu-option"
                        aria-pressed={level === rendition.index}
                        onClick={() => {
                          setLevel(rendition.index)
                          setMenu('closed')
                        }}
                      >
                        {rendition.height}p
                      </button>
                    ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Classed so a phone can drop it: the video there already runs the
            width of the screen, so theatre has nothing left to widen. */}
        <Control
          className="player-theater"
          label={theater ? '預設檢視模式' : '劇院模式'}
          shortcut="t"
          pressed={theater}
          onClick={toggleTheater}
        >
          <TheaterGlyph on={theater} />
        </Control>

        <Control
          label={fullscreen ? '結束全螢幕' : '全螢幕'}
          shortcut="f"
          onClick={toggleFullscreen}
        >
          {fullscreen ? <ShrinkGlyph /> : <ExpandGlyph />}
        </Control>
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

function VolumeGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M4 9.5v5h4l5 4v-13l-5 4z" />
      <path
        d="M16.5 8.5a5 5 0 0 1 0 7"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  )
}

function MutedGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M4 9.5v5h4l5 4v-13l-5 4z" />
      <path
        d="M15.5 9.5l5 5m0-5l-5 5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  )
}

/**
 * One control on the bar: an icon, and the tooltip that says what it is.
 *
 * The tooltip is drawn rather than left to the browser's `title`, for two
 * reasons. A `title` cannot show the keyboard shortcut as a key — a letter
 * in a box, which is what makes it read as something to press rather than
 * as part of the sentence — and it appears about a second late, which is
 * long enough that somebody has usually pressed the button to find out.
 *
 * The label is the state, not the control: "pause" over a playing video,
 * not "play/pause". A tooltip that says both says neither.
 */
function Control({
  label,
  shortcut,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  pressed?: boolean
  className?: string
  onClick: () => void
  children: ComponentChildren
}) {
  return (
    <button
      type="button"
      class={className}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
      {/* Hidden from assistive technology: it repeats the label, which is
          already the button's name. */}
      <span class="player-tip" aria-hidden="true">
        {label}
        {shortcut && <kbd>{shortcut}</kbd>}
      </span>
    </button>
  )
}

/**
 * A switch, not a symbol.
 *
 * Autoplay is the one control on the bar that is on or off rather than a
 * thing that happens when pressed, so the icon has to carry its own state:
 * the knob sits at the end the setting is at, and the track fills behind it
 * when it is on. An icon that looked the same either way would be a button
 * whose meaning is only in a tooltip.
 */
function AutoplayGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="2"
        y="6"
        width="20"
        height="12"
        rx="6"
        fill={on ? 'currentColor' : 'rgb(242 236 228 / 0.3)'}
      />
      <circle cx={on ? 16 : 8} cy="12" r="4.4" fill={on ? '#14110f' : 'currentColor'} />
      {/* The knob carries what pressing it leads to: playing on, or
          stopping at the end of this one. */}
      {on ? (
        <path d="M14.6 9.9 17.6 12l-3 2.1z" fill="currentColor" />
      ) : (
        <path d="M6.6 10h1.1v4H6.6zM8.3 10h1.1v4H8.3z" fill="#14110f" />
      )}
    </svg>
  )
}

/**
 * Which way the picture is about to go.
 *
 * The frame is the same either way and the arrows turn round: outward while
 * the video can still get wider, inward once it is wide and the button
 * brings it back. A fixed icon would leave the direction entirely to the
 * tooltip.
 */
function TheaterGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      {on ? <path d="M6 9.5 9 12l-3 2.5M18 9.5 15 12l3 2.5" /> : <path d="M9 9.5 6 12l3 2.5M15 9.5l3 2.5-3 2.5" />}
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

function GearGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
