import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import {
  PINNED,
  mirrorUrl,
  problemWith,
  verifyDownload,
  versionMatches,
} from '../shared/ffmpegRelease'

/**
 * Getting hold of the pinned FFmpeg, and refusing to run any other.
 *
 * The output layout is not a preference — the playback gateway builds object
 * keys from it and refuses anything else — so a different FFmpeg is a different
 * set of filenames, and that failure lands on a member watching a lesson.
 *
 * Only our own mirror. Official URLs change and old builds are removed, and
 * "try official, fall back to the mirror" leaves the least-tested path to run
 * for the first time on the day official actually breaks.
 */

export interface Tools {
  ffmpeg: string
  ffprobe: string
}

export class FfmpegUnavailable extends Error {}

function toolsDir(): string {
  const path = join(app.getPath('userData'), 'tools')
  mkdirSync(path, { recursive: true })
  return path
}

function installedAt(): Tools {
  const bin = join(toolsDir(), PINNED.binDir)
  return { ffmpeg: join(bin, 'ffmpeg.exe'), ffprobe: join(bin, 'ffprobe.exe') }
}

/**
 * Run a tool and collect what it said. Never through a shell.
 *
 * `onSpawn` hands back the process so a caller can stop it. An encode is tens of
 * minutes; without a way to kill it, "cancel" could only mean "stop watching".
 */
export function run(
  command: string,
  args: readonly string[],
  options: {
    onStdout?: (chunk: string) => void
    onSpawn?: (child: ReturnType<typeof spawn>) => void
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true })
    options.onSpawn?.(child)
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdout += text
      options.onStdout?.(text)
    })
    // Kept, but bounded: ffmpeg can produce a great deal of it, and the useful
    // part of a failure is the end.
    child.stderr.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString()}`.slice(-8_000)
    })

    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function isPinned(tools: Tools): Promise<boolean> {
  if (!existsSync(tools.ffmpeg) || !existsSync(tools.ffprobe)) return false
  try {
    const { stdout, stderr } = await run(tools.ffmpeg, ['-version'])
    return versionMatches(PINNED, `${stdout}${stderr}`)
  } catch {
    return false
  }
}

export interface FetchProgress {
  receivedBytes: number
  totalBytes: number
}

/**
 * Download the archive, check it, and unpack it.
 *
 * Written to a temporary name and moved into place only once the digest matches,
 * so an interrupted download cannot be mistaken for an installed tool on the
 * next launch.
 */
async function install(base: string, onProgress?: (progress: FetchProgress) => void): Promise<void> {
  const url = mirrorUrl(base, PINNED)
  const response = await fetch(url)
  if (!response.ok) {
    throw new FfmpegUnavailable(`無法從鏡像下載 FFmpeg（HTTP ${response.status}）`)
  }

  const chunks: Uint8Array[] = []
  let received = 0
  // Streamed so the interface can show something during a hundred-plus
  // megabytes on a domestic connection.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    received += chunk.byteLength
    onProgress?.({ receivedBytes: received, totalBytes: PINNED.bytes })
  }

  const archive = Buffer.concat(chunks)
  const problem = verifyDownload(PINNED, {
    bytes: archive.byteLength,
    sha256: createHash('sha256').update(archive).digest('hex'),
  })
  if (problem) {
    // Not retried. A hash mismatch on a correctly sized file is not bad luck.
    throw new FfmpegUnavailable(problem)
  }

  const pending = join(toolsDir(), `${PINNED.archive}.part`)
  const settled = join(toolsDir(), PINNED.archive)
  writeFileSync(pending, archive)
  renameSync(pending, settled)

  // `tar` rather than a dependency: Windows has shipped bsdtar since 1809 and it
  // reads zip. This is a Windows-only build, so that is not a limitation being
  // accepted here — it is the only platform there is.
  const extracted = await run('tar', ['-xf', settled, '-C', toolsDir()])
  if (extracted.code !== 0) {
    throw new FfmpegUnavailable(`FFmpeg 解壓縮失敗：${extracted.stderr.trim() || extracted.code}`)
  }
  rmSync(settled, { force: true })
}

/**
 * The pinned FFmpeg, downloading it once if this machine does not have it.
 *
 * The mirror has to be populated first — see `ffmpegRelease.ts`. Until then this
 * refuses with a sentence naming the file to fill in, which is a better failure
 * than a tool that transcodes with whatever FFmpeg happens to be on PATH and
 * produces filenames the gateway will not serve.
 */
export async function ensureTools(
  base: string,
  onProgress?: (progress: FetchProgress) => void,
): Promise<Tools> {
  const unconfigured = problemWith(PINNED)
  if (unconfigured) throw new FfmpegUnavailable(unconfigured)

  const tools = installedAt()
  if (await isPinned(tools)) return tools

  await install(base, onProgress)
  if (!(await isPinned(tools))) {
    throw new FfmpegUnavailable('下載完成但找不到符合版本的 FFmpeg，鏡像的內容可能不對')
  }
  return tools
}

/**
 * Where the licence and source live. GPL, so both ship.
 *
 * The terms shown in the interface are a bundled copy rather than a read of the
 * `licence` path here — reading it fails on every machine that has not
 * transcoded yet, and the failure looked like a stuck panel. This path stays
 * because the file still has to be *installed* beside the binary, and `source`
 * is what the interface reveals in the file manager.
 */
export function licencePaths(): { licence: string; source: string } {
  return {
    licence: join(toolsDir(), PINNED.binDir, '..', 'LICENSE'),
    source: join(toolsDir(), 'ffmpeg-source.tar.xz'),
  }
}
