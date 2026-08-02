import { useEffect, useRef } from 'preact/hooks'

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
  onError,
  onPosition,
  onEnded,
}: {
  src: string
  /** Named by the caller: the storefront and the back office style it apart. */
  class?: string
  onError?: () => void
  /** Called as playback proceeds, throttled by the caller, not here. */
  onPosition?: (seconds: number) => void
  onEnded?: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)

  // Through a ref, and not in the dependency list below. Both pages that use
  // this re-render on a timer and pass freshly-created callbacks each time; as
  // dependencies they tore the player down and rebuilt it on every tick, which
  // looks like a video that loads, vanishes, loads, vanishes.
  const handlers = useRef({ onError, onPosition, onEnded })
  handlers.current = { onError, onPosition, onEnded }

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
    let instance: { destroy(): void } | null = null

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
      instance = hls
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Only fatal ones. hls.js recovers from a good deal on its own, and
        // reporting the recoverable ones would show an error over a video
        // that is playing perfectly well.
        if (data.fatal) handlers.current.onError?.()
      })
      hls.loadSource(src)
      hls.attachMedia(video.current)
    })

    return () => {
      cancelled = true
      instance?.destroy()
    }
  }, [src])

  return (
    <video
      ref={video}
      class={className}
      controls
      crossOrigin="use-credentials"
      onTimeUpdate={(event) =>
        handlers.current.onPosition?.(Math.floor((event.currentTarget as HTMLVideoElement).currentTime))
      }
      onEnded={() => handlers.current.onEnded?.()}
    />
  )
}
