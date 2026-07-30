/**
 * Which FFmpeg this tool runs, and how it knows.
 *
 * Pinned, mirrored, and hash-checked. The reasoning is in the phase 4 design,
 * but the short version: the output layout is not a preference — the playback
 * gateway builds object keys from it and refuses anything else — so a different
 * FFmpeg is a different set of filenames, and the failure lands on a member
 * watching a lesson rather than here.
 *
 * Only our own R2 mirror. Official download URLs change, old builds are removed,
 * and "try official, fall back to the mirror" leaves the least-tested path to
 * run for the first time on the day official actually breaks.
 *
 * **An unset checksum means not configured, never "skip the check".** That is
 * the one way this file could quietly become decoration.
 */

export interface FfmpegRelease {
  /** As `ffmpeg -version` reports it, for checking a binary that is already here. */
  version: string
  /** Object name in the mirror. */
  archive: string
  /** SHA-256 of the archive, lowercase hex. */
  sha256: string
  /** Where the executables sit inside the archive, once extracted. */
  binDir: string
  /** Byte size, so a truncated download is caught before hashing it. */
  bytes: number
}

/**
 * Empty on purpose, and the tool refuses to transcode until it is filled.
 *
 * Filling it needs the mirror to exist: pick a build, upload it to R2, and put
 * its version, name, size and digest here. Until then `problemWith` says so, in
 * a sentence naming this file — a placeholder that silently disabled
 * verification would be worse than no verification, because it would look like
 * verification.
 */
export const PINNED: FfmpegRelease = {
  version: '',
  archive: '',
  sha256: '',
  binDir: '',
  bytes: 0,
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** Why this release cannot be used, or null. */
export function problemWith(release: FfmpegRelease): string | null {
  if (!release.version) return 'FFmpeg 版本尚未指定（見 src/shared/ffmpegRelease.ts）'
  if (!release.archive) return 'FFmpeg 鏡像檔名尚未指定（見 src/shared/ffmpegRelease.ts）'
  if (!SHA256_HEX.test(release.sha256)) {
    // Refused rather than treated as "no checksum configured, carry on".
    return 'FFmpeg 的 SHA-256 尚未填寫或格式不對（見 src/shared/ffmpegRelease.ts）'
  }
  if (!Number.isInteger(release.bytes) || release.bytes <= 0) {
    return 'FFmpeg 壓縮檔大小尚未填寫（見 src/shared/ffmpegRelease.ts）'
  }
  return null
}

export function isConfigured(release: FfmpegRelease = PINNED): boolean {
  return problemWith(release) === null
}

/**
 * Whether a downloaded archive is the one that was pinned.
 *
 * Size first because it is free and catches the common failure — a connection
 * that dropped — with a message that says so, instead of a digest mismatch that
 * reads like tampering.
 */
export function verifyDownload(
  release: FfmpegRelease,
  actual: { bytes: number; sha256: string },
): string | null {
  if (actual.bytes !== release.bytes) {
    return `下載的檔案大小不符（預期 ${release.bytes}，實際 ${actual.bytes}）—— 可能是連線中斷`
  }
  if (actual.sha256.toLowerCase() !== release.sha256.toLowerCase()) {
    // Not retried. A hash mismatch on a correctly sized file is not bad luck.
    return 'FFmpeg 的雜湊值不符，已停止使用這個檔案'
  }
  return null
}

/**
 * Whether a binary already on this machine is the pinned one.
 *
 * `ffmpeg -version` prints its version in the first line among other things, so
 * this looks for the string rather than parsing a format that differs between
 * builds.
 */
export function versionMatches(release: FfmpegRelease, output: string): boolean {
  if (!release.version) return false
  return typeof output === 'string' && output.includes(release.version)
}

/**
 * The mirror URL for the pinned archive.
 *
 * Derived from the admin API rather than configured separately: the mirror is
 * served by the same deployment, so a tool pointed at staging downloads
 * staging's copy instead of production's.
 */
export function mirrorUrl(base: string, release: FfmpegRelease = PINNED): string {
  return `${base}/tools/ffmpeg/${release.archive}`
}
