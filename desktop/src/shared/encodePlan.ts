/**
 * What to encode, at what settings, and what to say about it in the manifest.
 *
 * The rungs and their names mirror `video.RENDITIONS` in the backend, because
 * the names end up in object keys and the playback gateway refuses any it does
 * not recognise.
 *
 * All of it is pure. Deciding what to run is the part with rules worth checking;
 * running it is plumbing.
 */

export interface Rung {
  name: string
  height: number
  bitrateKbps: number
  maxrateKbps: number
  bufsizeKbps: number
}

/** Largest first, so `ladderFor` can filter and keep the order. */
export const RUNGS: readonly Rung[] = [
  { name: '1080p', height: 1080, bitrateKbps: 5_000, maxrateKbps: 5_350, bufsizeKbps: 7_500 },
  { name: '720p', height: 720, bitrateKbps: 2_800, maxrateKbps: 2_996, bufsizeKbps: 4_200 },
  { name: '480p', height: 480, bitrateKbps: 1_400, maxrateKbps: 1_498, bufsizeKbps: 2_100 },
]

/** Six seconds, with keyframes every two, so every segment starts on one. */
export const SEGMENT_SECONDS = 6
export const KEYFRAME_INTERVAL = 60

export interface Probed {
  width: number
  height: number
  durationSeconds: number
  hasAudio: boolean
}

export class UnusableSource extends Error {}

/**
 * What ffprobe found, or a refusal.
 *
 * The container and the extension are hints; this is the answer. A file named
 * `.mp4` that is something else, or a file with no video stream, is refused here
 * rather than after twenty minutes of encoding nothing.
 */
export function parseProbe(raw: unknown): Probed {
  const probe = raw as { streams?: unknown[]; format?: { duration?: unknown } } | null
  const streams = Array.isArray(probe?.streams) ? (probe!.streams as Record<string, unknown>[]) : []

  const video = streams.find((stream) => stream.codec_type === 'video')
  if (!video) throw new UnusableSource('這個檔案裡沒有影像軌，可能不是影片檔')

  const width = Number(video.width)
  const height = Number(video.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new UnusableSource('無法讀出影片的尺寸')
  }

  const duration = Number(probe?.format?.duration)
  return {
    width: Math.round(width),
    height: Math.round(height),
    // A missing duration is not fatal — it is shown in the library and nothing
    // depends on it — so zero rather than a refusal.
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  }
}

/**
 * Which rungs to produce for a source this tall.
 *
 * Never above the source: upscaling spends bandwidth and storage to deliver a
 * blurrier file than the one that came in. A source shorter than the smallest
 * rung still gets that rung, because the encoder letterboxes down to it — one
 * playable rendition beats an asset with no ladder at all.
 *
 * Mirrors `video.ladder_for`. A disagreement would produce output the server
 * refuses to sign.
 */
export function ladderFor(height: number): Rung[] {
  if (!Number.isFinite(height) || height <= 0) {
    throw new UnusableSource('無法讀出影片高度，因此無法決定畫質階梯')
  }
  const fitting = RUNGS.filter((rung) => rung.height <= height)
  return fitting.length > 0 ? [...fitting] : [RUNGS[RUNGS.length - 1]!]
}

/** Even, because H.264 chroma subsampling needs it and ffmpeg will refuse odd. */
export function widthFor(rung: Rung, source: Probed): number {
  return Math.round((source.width * rung.height) / source.height / 2) * 2
}

/**
 * The arguments for one rung.
 *
 * Nothing here is interpolated from a filename. Paths are passed as separate
 * argv entries and the process is spawned without a shell, so a source called
 * `"; rm -rf` is a file with a strange name rather than a command.
 */
export function ffmpegArgs(options: {
  source: string
  rung: Rung
  outDir: string
  segmentPattern: string
  playlist: string
  hasAudio: boolean
}): string[] {
  const { source, rung, segmentPattern, playlist, hasAudio } = options
  return [
    '-hide_banner',
    '-loglevel', 'error',
    // Progress on stdout in a parseable form, rather than scraping the log.
    '-progress', 'pipe:1',
    '-nostats',
    '-y',
    '-i', source,
    '-vf', `scale=-2:${rung.height}`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-profile:v', 'high',
    '-crf', '21',
    '-b:v', `${rung.bitrateKbps}k`,
    '-maxrate', `${rung.maxrateKbps}k`,
    '-bufsize', `${rung.bufsizeKbps}k`,
    // A player can only change rendition at a keyframe, so every segment has to
    // begin with one. Without these three the switch stutters or fails.
    '-g', String(KEYFRAME_INTERVAL),
    '-keyint_min', String(KEYFRAME_INTERVAL),
    '-sc_threshold', '0',
    // `-an` when there is no audio: naming an audio codec for a source with no
    // audio stream is harmless to ffmpeg and confusing to read.
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', segmentPattern,
    playlist,
  ]
}

export function posterArgs(options: { source: string; out: string; atSeconds: number }): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    // Before `-i`, so ffmpeg seeks rather than decoding everything up to it.
    '-ss', String(options.atSeconds),
    '-i', options.source,
    '-frames:v', '1',
    // Named, not inferred. For a `.webp` output ffmpeg selects `libwebp_anim`
    // even with `-frames:v 1` — the animated encoder — and on a real lesson that
    // failed outright: `[vost#0:0/libwebp_anim] Terminating thread with return
    // code -12 (Cannot allocate memory)`. It allocates for a sequence, and this
    // is one frame.
    '-c:v', 'libwebp',
    // A poster has no use for audio, and mapping a track into a webp is a class
    // of muxer complaint that need not exist.
    '-an',
    '-vf', 'scale=-2:720',
    options.out,
  ]
}

/**
 * Far enough in to be the lesson rather than a title card, and never past the
 * end of a short one.
 */
export function posterOffset(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1
  return Math.max(1, Math.min(10, Math.floor(durationSeconds / 10)))
}

/**
 * The master playlist, written by hand rather than by ffmpeg's `var_stream_map`.
 *
 * The relative paths in here are what the playback gateway turns into object
 * keys, and it accepts exactly one folder of depth. Writing it here is how that
 * stays true regardless of what a future ffmpeg would have chosen.
 *
 * `CODECS` omits the audio codec when the source has none. The script this
 * replaces always claimed `mp4a.40.2`, which is a manifest promising an audio
 * track that is not there — some players treat that as a broken stream rather
 * than a silent one.
 */
export function masterPlaylist(rungs: readonly Rung[], source: Probed): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7']
  for (const rung of rungs) {
    const codecs = source.hasAudio ? 'avc1.640028,mp4a.40.2' : 'avc1.640028'
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rung.bitrateKbps * 1000}` +
        `,RESOLUTION=${widthFor(rung, source)}x${rung.height}` +
        `,CODECS="${codecs}"`,
    )
    lines.push(`${rung.name}/playlist.m3u8`)
  }
  // No trailing newline: the gateway compares this against what it verified, and
  // the script it replaces wrote none either.
  return lines.join('\n')
}

/**
 * How far through an encode ffmpeg's `-progress` output says it is.
 *
 * `out_time_us` against the source duration. Returns null for a line that says
 * nothing about position, so a caller can ignore it rather than guess.
 */
export function progressFraction(chunk: string, durationSeconds: number): number | null {
  if (durationSeconds <= 0) return null
  const match = /out_time_(?:us|ms)=(\d+)/.exec(chunk)
  if (!match) return null
  const divisor = chunk.includes('out_time_ms=') ? 1_000 : 1_000_000
  const seconds = Number(match[1]) / divisor
  if (!Number.isFinite(seconds)) return null
  return Math.max(0, Math.min(1, seconds / durationSeconds))
}
