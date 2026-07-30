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
import { requireToken } from './session'

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

/** The environment variable that points at an FFmpeg already on this machine. */
export const OVERRIDE_VAR = 'LUMA_FFMPEG_DIR'

/**
 * An FFmpeg somebody on this machine already has, for development only.
 *
 * The mirror is what every installed copy uses, and it cannot exist until
 * somebody uploads a build to it. Without an escape hatch, nothing about
 * transcoding can be exercised until that day — which is how a whole feature
 * ends up first run in anger.
 *
 * Two limits make this safe to leave in:
 *
 * **Never in a packaged build.** `app.isPackaged` is the gate. An installed tool
 * that could be pointed at an arbitrary encoder by setting an environment
 * variable is an installed tool with no pin at all, and the pin is what keeps the
 * output servable.
 *
 * **The version is still checked once there is one to check.** If `PINNED` names
 * a version, a borrowed binary reporting a different one is refused. The digest
 * and the version are never configurable — only where to look is.
 */
async function borrowedTools(): Promise<Tools | null> {
  const dir = process.env[OVERRIDE_VAR]
  if (!dir) return null
  if (app.isPackaged) {
    throw new FfmpegUnavailable(
      `${OVERRIDE_VAR} 只在開發時有效，安裝後的版本一律使用釘死的 FFmpeg。`,
    )
  }

  const tools = { ffmpeg: join(dir, 'ffmpeg.exe'), ffprobe: join(dir, 'ffprobe.exe') }
  for (const [what, path] of Object.entries(tools)) {
    if (!existsSync(path)) {
      throw new FfmpegUnavailable(`${OVERRIDE_VAR} 指向 ${dir}，但那裡沒有 ${what}.exe。`)
    }
  }

  if (PINNED.version && !(await isPinned(tools))) {
    throw new FfmpegUnavailable(
      `${OVERRIDE_VAR} 指向的 FFmpeg 不是釘死的版本（需要 ${PINNED.version}）。`,
    )
  }

  console.warn(`[ffmpeg] 使用 ${OVERRIDE_VAR}=${dir}，未經釘死版本檢查。這只該出現在開發環境。`)
  return tools
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
  // The mirror is behind the desktop token. The bytes are a published GPL build
  // and not a secret — what the token protects is our bandwidth, and the tool
  // has one by the time it has an MP4 to encode.
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requireToken().token}` },
  })
  if (!response.ok) {
    throw new FfmpegUnavailable(
      response.status === 401 || response.status === 403
        ? '配對已過期，請重新配對後再試'
        : `無法從鏡像下載 FFmpeg（HTTP ${response.status}）`,
    )
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
  const borrowed = await borrowedTools()
  if (borrowed) return borrowed

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
    // Beside the executables, because that is how the archive is packed: the
    // repacked zip holds `ffmpeg.exe`, `ffprobe.exe` and `LICENSE` in one folder.
    // This said `binDir/../LICENSE` while the archive was still hypothetical.
    licence: join(toolsDir(), PINNED.binDir, 'LICENSE'),
    source: join(toolsDir(), 'ffmpeg-source.tar.xz'),
  }
}
