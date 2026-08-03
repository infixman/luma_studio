import { useEffect, useRef } from 'preact/hooks'
import type Hls from 'hls.js'

/** One rung of the encode ladder, as hls.js found it in the manifest. */
export interface HlsRendition {
  /** hls.js's own index for it, which is what `level` takes. */
  index: number
  /** 1080, 720, 480 — the number people call a rendition by. */
  height: number
}

/** hls.js's own value for "let the bitrate algorithm choose". */
export const AUTO_LEVEL = -1

/**
 * An HLS player that works outside Safari.
 *
 * Safari plays an .m3u8 from a plain `src`. Chrome and Firefox do not, and
 * fail silently — the element simply never produces a frame, which looks
 * exactly like a broken video rather than a missing codec. So everywhere else
 * needs hls.js, and hls.js is loaded on demand rather than bundled into the
 * storefront: most visits are shopping, not watching, and this is a couple of
 * hundred kilobytes nobody browsing a product page should pay for.
 *
 * Every request carries credentials. The permission to watch is a cookie
 * scoped to the media path, and a request without it gets a 403.
 */
export function HlsVideo({
  src,
  class: className = 'learn-video',
  controls = true,
  mediaRef,
  onError,
  onPosition,
  onEnded,
  level,
  onRenditions,
  onPlayingRendition,
}: {
  src: string
  /** Named by the caller: the storefront and the back office style it apart. */
  class?: string
  /**
   * The browser's own control bar. On by default, so adding this changed
   * nothing for anybody already using it.
   *
   * The back office keeps it: it is a tool, the job there is checking that a
   * transcode came out right, and the native bar is the one every browser
   * already knows how to make accessible. A caller drawing its own turns this
   * off — two bars over one video disagree about it.
   */
  controls?: boolean
  /**
   * The media element, for a caller drawing its own controls. Play, pause,
   * seek and volume all live on the element; without it there is nothing for
   * a control bar to control.
   */
  mediaRef?: { current: HTMLVideoElement | null }
  onError?: () => void
  /** Called as playback proceeds, throttled by the caller, not here. */
  onPosition?: (seconds: number) => void
  onEnded?: () => void
  /**
   * Which rendition to play, by the index `onRenditions` gave. Absent — or
   * AUTO_LEVEL — leaves it to hls.js, which is what the storefront wants: a
   * member watching a lesson should not have to choose.
   */
  level?: number
  /** The ladder, once the manifest names it. */
  onRenditions?: (renditions: HlsRendition[]) => void
  /** Which rendition is on screen now. Changes on its own while hls.js is
   *  choosing, which is the reason it is worth reporting at all. */
  onPlayingRendition?: (height: number | null) => void
}) {
  const video = useRef<HTMLVideoElement>(null)

  // Through a ref, and not in the dependency list below. Both pages that use
  // this re-render on a timer and pass freshly-created callbacks each time; as
  // dependencies they tore the player down and rebuilt it on every tick, which
  // looks like a video that loads, vanishes, loads, vanishes.
  const handlers = useRef({ onError, onPosition, onEnded, onRenditions, onPlayingRendition })
  handlers.current = { onError, onPosition, onEnded, onRenditions, onPlayingRendition }

  // The same rule applied to the choice of rendition: it is pushed into the
  // player that is already running, never a reason to build a new one. A rebuilt
  // player starts at zero, and what the admin was looking at closely is gone.
  const player = useRef<Hls | null>(null)
  const wanted = useRef(level ?? AUTO_LEVEL)
  wanted.current = level ?? AUTO_LEVEL

  useEffect(() => {
    // Null until hls.js has finished loading; the manifest handler applies the
    // choice in that case.
    if (player.current) player.current.currentLevel = wanted.current
  }, [level])

  useEffect(() => {
    const element = video.current
    if (!element) return

    // Safari and iOS. Native playback also means one less thing between the
    // bytes and the screen, so it is preferred where it exists.
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = src
      return
    }

    let cancelled = false

    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled || !video.current) return
      if (!Hls.isSupported()) {
        handlers.current.onError?.()
        return
      }
      const hls = new Hls({
        // The manifest and every segment go through the gateway, which
        // authorises on a cookie. Without this they are sent bare and 403.
        xhrSetup: (xhr) => {
          xhr.withCredentials = true
        },
      })
      player.current = hls
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Only fatal ones. hls.js recovers from a good deal on its own, and
        // reporting the recoverable ones would show an error over a video
        // that is playing perfectly well.
        if (data.fatal) handlers.current.onError?.()
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        handlers.current.onRenditions?.(
          hls.levels.map((rung, index) => ({ index, height: rung.height })),
        )
        // A choice made before this player existed — the source changed under a
        // caller that had already picked — would otherwise fall back to auto
        // without saying so.
        if (wanted.current !== AUTO_LEVEL) hls.currentLevel = wanted.current
      })
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        handlers.current.onPlayingRendition?.(hls.levels[data.level]?.height ?? null)
      })
      hls.loadSource(src)
      hls.attachMedia(video.current)
    })

    return () => {
      cancelled = true
      player.current?.destroy()
      player.current = null
    }
  }, [src])

  return (
    <video
      // Both refs from one callback: this component needs the element for
      // hls.js, and the caller needs the same element for its own bar.
      ref={(element) => {
        video.current = element
        if (mediaRef) mediaRef.current = element
      }}
      class={className}
      controls={controls}
      crossOrigin="use-credentials"
      onTimeUpdate={(event) =>
        handlers.current.onPosition?.(Math.floor((event.currentTarget as HTMLVideoElement).currentTime))
      }
      onEnded={() => handlers.current.onEnded?.()}
    />
  )
}
