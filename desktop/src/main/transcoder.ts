import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { app } from 'electron'

import {
  UnusableSource,
  ffmpegArgs,
  ladderFor,
  masterPlaylist,
  parseProbe,
  posterArgs,
  posterOffset,
  progressFraction,
  type Probed,
  type Rung,
} from '../shared/encodePlan'
import { ensureTools, run, type FetchProgress, type Tools } from './ffmpeg'

/**
 * Stopping a job in progress.
 *
 * An encode is tens of minutes, so cancelling has to actually kill ffmpeg
 * rather than stop listening to it — otherwise the machine keeps a core busy
 * for half an hour on output nobody will use.
 */
export class Cancelled extends Error {}

let running: { kill: () => void } | null = null
let cancelled = false

export function cancel(): void {
  cancelled = true
  running?.kill()
}

function stopIfCancelled(): void {
  if (cancelled) throw new Cancelled('已取消')
}

/**
 * Whether the person asked for this job to stop.
 *
 * Exported because cancelling has to reach past the encoder now: sending the
 * original is a multi-gigabyte transfer, and a cancel that only kills ffmpeg
 * leaves it running with nothing on screen to say so.
 */
export function isCancelled(): boolean {
  return cancelled
}

/**
 * Turning one high-quality MP4 into the ladder this shop serves.
 *
 * The decisions are all in `shared/encodePlan.ts`, where they can be tested.
 * What is here is running processes and putting files in the right place, which
 * is the part no test would tell the truth about.
 *
 * The output goes to a working directory under userData and is handed to the
 * uploader as an ordinary folder — the same input the previous step already
 * takes. That is why they are separate: uploading was proven against output
 * known to be correct before anything generated it.
 */

export interface TranscodeProgress {
  phase: 'preparing' | 'probing' | 'encoding' | 'poster' | 'writing' | 'done'
  /** 0–1 across the whole job, not per rung. */
  fraction: number
  rung?: string
  message?: string
}

export interface TranscodeResult {
  folder: string
  probed: Probed
  rungs: string[]
}

function workingDir(source: string): string {
  // Named after the source and the clock, so two runs of the same file do not
  // write into each other. Cleaned up by the caller once uploaded.
  const stamp = `${Date.now().toString(36)}`
  const path = join(app.getPath('userData'), 'encodes', `${basename(source, '.mp4')}-${stamp}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function probeSource(tools: Tools, source: string): Promise<Probed> {
  const { code, stdout, stderr } = await run(tools.ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    source,
  ])
  if (code !== 0) {
    throw new UnusableSource(`無法讀取這個影片檔${stderr.trim() ? `：${stderr.trim()}` : ''}`)
  }
  try {
    return parseProbe(JSON.parse(stdout))
  } catch (error) {
    if (error instanceof UnusableSource) throw error
    throw new UnusableSource('ffprobe 的輸出無法解析，這個檔案可能損壞')
  }
}

async function encodeRung(
  tools: Tools,
  options: {
    source: string
    rung: Rung
    root: string
    probed: Probed
    onFraction: (fraction: number) => void
  },
): Promise<void> {
  const dir = join(options.root, options.rung.name)
  mkdirSync(dir, { recursive: true })

  stopIfCancelled()
  const { code, stderr } = await run(
    tools.ffmpeg,
    ffmpegArgs({
      source: options.source,
      rung: options.rung,
      segmentPattern: join(dir, 'segment-%06d.m4s'),
      playlist: join(dir, 'playlist.m3u8'),
      hasAudio: options.probed.hasAudio,
    }),
    {
      onSpawn: (child) => {
        running = { kill: () => child.kill() }
      },
      onStdout: (chunk) => {
        const fraction = progressFraction(chunk, options.probed.durationSeconds)
        if (fraction !== null) options.onFraction(fraction)
      },
    },
  )
  running = null

  // A killed process exits non-zero, so the cancellation has to be recognised
  // before the exit code is read as a failure to report.
  stopIfCancelled()
  if (code !== 0) {
    // The end of stderr, which is where ffmpeg says what it could not do.
    throw new Error(`${options.rung.name} 轉檔失敗：${stderr.trim().split('\n').at(-1) ?? code}`)
  }
}

export async function transcode(
  source: string,
  base: string,
  onProgress: (progress: TranscodeProgress) => void,
): Promise<TranscodeResult> {
  cancelled = false
  onProgress({ phase: 'preparing', fraction: 0, message: '檢查 FFmpeg' })
  const tools = await ensureTools(base, (fetched: FetchProgress) => {
    const fraction = fetched.totalBytes > 0 ? fetched.receivedBytes / fetched.totalBytes : 0
    onProgress({
      phase: 'preparing',
      fraction: 0,
      message: `下載 FFmpeg：${Math.round(fraction * 100)}%`,
    })
  })

  onProgress({ phase: 'probing', fraction: 0 })
  const probed = await probeSource(tools, source)
  const rungs = ladderFor(probed.height)

  const root = workingDir(source)
  // Each rung is a share of the whole, so the bar moves once rather than three
  // times from zero. The poster and the manifest are the last few per cent.
  const share = 0.95 / rungs.length

  for (const [index, rung] of rungs.entries()) {
    onProgress({ phase: 'encoding', rung: rung.name, fraction: index * share })
    await encodeRung(tools, {
      source,
      rung,
      root,
      probed,
      onFraction: (fraction) =>
        onProgress({ phase: 'encoding', rung: rung.name, fraction: (index + fraction) * share }),
    })
  }

  stopIfCancelled()
  onProgress({ phase: 'poster', fraction: 0.96 })
  const poster = await run(
    tools.ffmpeg,
    posterArgs({
      source,
      out: join(root, 'poster.webp'),
      atSeconds: posterOffset(probed.durationSeconds),
    }),
  )
  if (poster.code !== 0) {
    throw new Error(`產生封面失敗：${poster.stderr.trim().split('\n').at(-1) ?? poster.code}`)
  }

  // Last, and by hand. Registration reads the master first, so a job that died
  // earlier leaves a folder the server refuses with one sentence rather than a
  // list of everything absent.
  onProgress({ phase: 'writing', fraction: 0.98 })
  writeFileSync(join(root, 'master.m3u8'), masterPlaylist(rungs, probed), 'utf8')

  onProgress({ phase: 'done', fraction: 1 })
  return { folder: root, probed, rungs: rungs.map((rung) => rung.name) }
}

/**
 * Remove a working directory once its contents are safely uploaded.
 *
 * Called after registration succeeds, never before: an encode that failed to
 * upload is worth keeping, because re-uploading is minutes and re-encoding is
 * an hour.
 */
export function discard(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch {
    // A file still open, or already gone. Leaving it costs disk, not
    // correctness, and the next run writes to a different directory.
  }
}
