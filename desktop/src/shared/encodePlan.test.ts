import { describe, expect, test } from 'vitest'

import {
  RUNGS,
  UnusableSource,
  ffmpegArgs,
  ladderFor,
  masterPlaylist,
  parseProbe,
  posterArgs,
  posterOffset,
  progressFraction,
  widthFor,
  type Probed,
} from './encodePlan'

function probe(streams: unknown[], duration?: unknown) {
  return { streams, format: duration === undefined ? {} : { duration } }
}

const A_SOURCE: Probed = { width: 3840, height: 2160, durationSeconds: 1830, hasAudio: true }

describe('reading what ffprobe found', () => {
  test('the real dimensions come from the video stream', () => {
    /** The extension and the container are hints; this is the answer. */
    const found = parseProbe(probe([{ codec_type: 'video', width: 1920, height: 1080 }], '600.4'))

    expect(found).toEqual({ width: 1920, height: 1080, durationSeconds: 600, hasAudio: false })
  })

  test('an audio stream is noticed', () => {
    const found = parseProbe(
      probe([{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }], '10'),
    )

    expect(found.hasAudio).toBe(true)
  })

  test('a file with no video stream is refused', () => {
    /** Refused here rather than after twenty minutes of encoding nothing. */
    expect(() => parseProbe(probe([{ codec_type: 'audio' }]))).toThrow(UnusableSource)
  })

  test('a video stream with no dimensions is refused', () => {
    expect(() => parseProbe(probe([{ codec_type: 'video' }]))).toThrow(UnusableSource)
  })

  test('nothing at all is refused', () => {
    expect(() => parseProbe(null)).toThrow(UnusableSource)
    expect(() => parseProbe({})).toThrow(UnusableSource)
  })

  test('a missing duration is zero rather than a refusal', () => {
    /** It is shown in the library and nothing depends on it. */
    const found = parseProbe(probe([{ codec_type: 'video', width: 640, height: 360 }]))

    expect(found.durationSeconds).toBe(0)
  })

  test('a duration of N/A is zero too', () => {
    const found = parseProbe(probe([{ codec_type: 'video', width: 640, height: 360 }], 'N/A'))

    expect(found.durationSeconds).toBe(0)
  })
})

describe('the ladder', () => {
  test('a 4K source gets all three rungs', () => {
    expect(ladderFor(2160).map((rung) => rung.name)).toEqual(['1080p', '720p', '480p'])
  })

  test('a 720p source gets 720 and below, never 1080', () => {
    /** Upscaling spends bandwidth and storage to deliver a blurrier file than
     *  the one that came in. */
    expect(ladderFor(720).map((rung) => rung.name)).toEqual(['720p', '480p'])
  })

  test('a source between rungs does not get the one above it', () => {
    expect(ladderFor(1000).map((rung) => rung.name)).toEqual(['720p', '480p'])
  })

  test('a source shorter than the smallest rung still gets one', () => {
    /** The encoder letterboxes down to it. One playable rendition beats an
     *  asset with no ladder at all. */
    expect(ladderFor(320).map((rung) => rung.name)).toEqual(['480p'])
  })

  test('an unreadable height is refused', () => {
    expect(() => ladderFor(0)).toThrow(UnusableSource)
    expect(() => ladderFor(Number.NaN)).toThrow(UnusableSource)
  })

  test('the rung names are the ones the server accepts', () => {
    /** They end up in object keys, and the playback gateway refuses any name it
     *  does not know. */
    expect(RUNGS.map((rung) => rung.name)).toEqual(['1080p', '720p', '480p'])
  })
})

describe('widths', () => {
  test('a 16:9 source keeps its aspect ratio', () => {
    expect(widthFor(RUNGS[0]!, A_SOURCE)).toBe(1920)
  })

  test('a vertical source gets a narrow width, not a stretched one', () => {
    const vertical: Probed = { width: 1080, height: 1920, durationSeconds: 60, hasAudio: true }

    expect(widthFor(RUNGS[1]!, vertical)).toBe(406)
  })

  test('the width is always even', () => {
    /** H.264 chroma subsampling needs it, and ffmpeg refuses an odd one. */
    const awkward: Probed = { width: 1435, height: 1080, durationSeconds: 60, hasAudio: true }

    for (const rung of RUNGS) {
      expect(widthFor(rung, awkward) % 2).toBe(0)
    }
  })
})

describe('the ffmpeg arguments', () => {
  const args = ffmpegArgs({
    source: 'C:\\videos\\lesson 01.mp4',
    rung: RUNGS[1]!,
    outDir: 'out/720p',
    segmentPattern: 'out/720p/segment-%06d.m4s',
    playlist: 'out/720p/playlist.m3u8',
    hasAudio: true,
  })

  test('the source is a single argument, not interpolated into one', () => {
    /** Spawned without a shell and passed as argv, so a file called
     *  `"; rm -rf` is a strange filename rather than a command. */
    expect(args).toContain('C:\\videos\\lesson 01.mp4')
  })

  test('keyframes are forced onto segment boundaries', () => {
    /** A player can only change rendition at a keyframe. Without these the
     *  switch stutters or fails. */
    expect(args).toContain('-g')
    expect(args).toContain('-keyint_min')
    expect(args.join(' ')).toContain('-sc_threshold 0')
  })

  test('the output is fMP4 HLS with a named init segment', () => {
    const joined = args.join(' ')

    expect(joined).toContain('-hls_segment_type fmp4')
    expect(joined).toContain('-hls_fmp4_init_filename init.mp4')
    expect(joined).toContain('-hls_playlist_type vod')
  })

  test('it never upscales — the scale filter targets the rung height', () => {
    expect(args.join(' ')).toContain('scale=-2:720')
  })

  test('progress is asked for in a parseable form', () => {
    /** Rather than scraping the human-readable log, which changes between
     *  builds. */
    expect(args.join(' ')).toContain('-progress pipe:1')
  })

  test('a source with no audio is encoded with no audio', () => {
    /** Naming an audio codec for a stream that is not there is confusing to
     *  read and pointless to run. */
    const silent = ffmpegArgs({
      source: 's.mp4',
      rung: RUNGS[2]!,
      outDir: 'o',
      segmentPattern: 'o/segment-%06d.m4s',
      playlist: 'o/playlist.m3u8',
      hasAudio: false,
    })

    expect(silent).toContain('-an')
    expect(silent).not.toContain('aac')
  })
})

describe('the poster', () => {
  test('it comes from far enough in to be the lesson', () => {
    /** Rather than a title card. */
    expect(posterOffset(1800)).toBe(10)
  })

  test('a short video is not sampled past its end', () => {
    expect(posterOffset(12)).toBe(1)
    expect(posterOffset(3)).toBe(1)
  })

  test('an unknown duration still yields a valid offset', () => {
    expect(posterOffset(0)).toBe(1)
  })

  test('the seek comes before the input, so ffmpeg does not decode up to it', () => {
    const args = posterArgs({ source: 's.mp4', out: 'poster.webp', atSeconds: 10 })

    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
  })
})

describe('the master playlist', () => {
  test('it lists each rung one folder deep', () => {
    /** The gateway turns these relative paths into object keys and accepts
     *  exactly one folder of depth. */
    const master = masterPlaylist(ladderFor(1080), A_SOURCE)

    expect(master).toContain('1080p/playlist.m3u8')
    expect(master).toContain('720p/playlist.m3u8')
    expect(master).not.toContain('..')
  })

  test('it opens with the tag a player looks for', () => {
    expect(masterPlaylist(ladderFor(720), A_SOURCE).startsWith('#EXTM3U')).toBe(true)
  })

  test('it carries a bandwidth and a resolution per rung', () => {
    const master = masterPlaylist([RUNGS[1]!], A_SOURCE)

    expect(master).toContain('BANDWIDTH=2800000')
    expect(master).toContain('RESOLUTION=1280x720')
  })

  test('a silent source does not claim an audio codec', () => {
    /** The script this replaces always claimed `mp4a.40.2`. A manifest that
     *  promises an audio track which is not there is treated by some players as
     *  a broken stream rather than a silent one. */
    const silent: Probed = { ...A_SOURCE, hasAudio: false }

    const master = masterPlaylist([RUNGS[2]!], silent)

    expect(master).toContain('CODECS="avc1.640028"')
    expect(master).not.toContain('mp4a')
  })

  test('a source with audio does claim one', () => {
    expect(masterPlaylist([RUNGS[2]!], A_SOURCE)).toContain('mp4a.40.2')
  })

  test('it ends without a trailing newline', () => {
    /** The script it replaces wrote none, and the gateway compares what it
     *  verified. */
    expect(masterPlaylist([RUNGS[2]!], A_SOURCE).endsWith('\n')).toBe(false)
  })
})

describe('progress', () => {
  test('a position halfway through reads as half', () => {
    expect(progressFraction('out_time_us=30000000', 60)).toBeCloseTo(0.5)
  })

  test('the millisecond form is understood too', () => {
    /** Older builds print `out_time_ms`, and reading it as microseconds would
     *  make the bar crawl. */
    expect(progressFraction('out_time_ms=30000', 60)).toBeCloseTo(0.5)
  })

  test('a line about something else is ignored rather than guessed at', () => {
    expect(progressFraction('frame=120', 60)).toBeNull()
  })

  test('it never exceeds one', () => {
    /** ffmpeg reports slightly past the end on the final flush. */
    expect(progressFraction('out_time_us=61000000', 60)).toBe(1)
  })

  test('an unknown duration yields nothing rather than a division by zero', () => {
    expect(progressFraction('out_time_us=1000000', 0)).toBeNull()
  })
})
