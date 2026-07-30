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
 * The build in the mirror, as of 2026-07-30.
 *
 * A gyan.dev release build, repacked: `ffmpeg.exe`, `ffprobe.exe` and `LICENSE`
 * and nothing else. `ffplay.exe` is a media player this tool has no use for and
 * the largest file in the original archive. Repacking is not a shortcut — the
 * mirror is our own object and the digest below is of our own archive.
 *
 * A `.zip`, not the `.7z` gyan publishes: unpacking uses the bsdtar that ships
 * with Windows, which reads zip and not 7z.
 *
 * `version` is a substring match against `ffmpeg -version`, so it is the build
 * tag rather than the whole line — the line also carries a copyright year.
 *
 * Changing any of this means uploading a new object under a new name. Editing a
 * digest to match a file that is already in the mirror is how the check becomes
 * decoration.
 */
export const PINNED: FfmpegRelease = {
  version: '8.1.2-essentials_build',
  archive: 'ffmpeg-8.1.2.zip',
  sha256: '76ad7cad3f8efdb5d6e7e357b2da386fafffffc690a638e3561fd2b226a9827aa',
  // The folder inside the archive. The two executables sit directly in it, which
  // is a property of how it was repacked rather than of gyan's layout.
  binDir: 'ffmpeg-8.1.2',
  bytes: 74_157_700,
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
