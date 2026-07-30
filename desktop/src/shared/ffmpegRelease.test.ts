import { describe, expect, test } from 'vitest'

import {
  PINNED,
  isConfigured,
  mirrorUrl,
  problemWith,
  verifyDownload,
  versionMatches,
  type FfmpegRelease,
} from './ffmpegRelease'

const A_RELEASE: FfmpegRelease = {
  version: '7.1.1',
  archive: 'ffmpeg-7.1.1-win64-gpl.zip',
  sha256: 'a'.repeat(64),
  binDir: 'ffmpeg-7.1.1-win64-gpl/bin',
  bytes: 123_456_789,
}

describe('the pin that ships', () => {
  test('it is configured', () => {
    /** It was not, for as long as the mirror did not exist. Now it does, and a
     *  build that shipped with an empty pin would refuse to transcode at all. */
    expect(isConfigured(PINNED)).toBe(true)
    expect(problemWith(PINNED)).toBeNull()
  })

  test('the digest is a whole SHA-256 and nothing else', () => {
    /** The first value written here had sixty-five characters — one duplicated
     *  `f` from a copied line. `problemWith` refused it, which is the behaviour
     *  worth keeping: a malformed digest is "not configured", never "skip the
     *  check". This pins the length so a bad paste fails here rather than after a
     *  74 MB download. */
    expect(PINNED.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('and the archive is a zip, because bsdtar cannot read 7z', () => {
    /** Unpacking uses the bsdtar Windows ships. The published build is a `.7z`,
     *  so the mirrored copy is repacked — and a pin that named a 7z would get
     *  through every check here and fail at extraction. */
    expect(PINNED.archive).toMatch(/\.zip$/)
  })
})

describe('what counts as configured', () => {
  test('a filled release is', () => {
    expect(problemWith(A_RELEASE)).toBeNull()
  })

  test('a missing version is not', () => {
    expect(problemWith({ ...A_RELEASE, version: '' })).toContain('版本')
  })

  test('a missing archive name is not', () => {
    expect(problemWith({ ...A_RELEASE, archive: '' })).toContain('檔名')
  })

  test.each(['', 'not-a-hash', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])(
    'a checksum of %s is refused',
    (sha256) => {
      /** The important one. An empty or malformed digest must mean "not
       *  configured", never "skip the check" — a placeholder that silently
       *  disabled verification would look exactly like verification. */
      expect(problemWith({ ...A_RELEASE, sha256 })).toContain('SHA-256')
    },
  )

  test('a missing size is refused', () => {
    expect(problemWith({ ...A_RELEASE, bytes: 0 })).toContain('大小')
  })
})

describe('checking a download', () => {
  test('the pinned archive passes', () => {
    expect(verifyDownload(A_RELEASE, { bytes: A_RELEASE.bytes, sha256: A_RELEASE.sha256 })).toBeNull()
  })

  test('a short file is reported as a dropped connection, not tampering', () => {
    /** It is the common failure, and a digest mismatch reads like an attack. */
    const problem = verifyDownload(A_RELEASE, { bytes: 1_000, sha256: A_RELEASE.sha256 })

    expect(problem).toContain('連線中斷')
  })

  test('a full-size file with the wrong hash is refused outright', () => {
    const problem = verifyDownload(A_RELEASE, { bytes: A_RELEASE.bytes, sha256: 'b'.repeat(64) })

    expect(problem).toContain('雜湊值不符')
  })

  test('case in the digest does not matter', () => {
    /** Different tools print it differently, and that is not a mismatch. */
    const problem = verifyDownload(A_RELEASE, {
      bytes: A_RELEASE.bytes,
      sha256: A_RELEASE.sha256.toUpperCase(),
    })

    expect(problem).toBeNull()
  })
})

describe('checking a binary that is already here', () => {
  test('the pinned version is recognised in the usual banner', () => {
    const banner = 'ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright (c) 2000-2025'

    expect(versionMatches(A_RELEASE, banner)).toBe(true)
  })

  test('another version is not', () => {
    expect(versionMatches(A_RELEASE, 'ffmpeg version 6.0 Copyright (c)')).toBe(false)
  })

  test('an unconfigured pin matches nothing', () => {
    /** Otherwise an empty version string would be "contained" in every banner
     *  and every FFmpeg on the machine would look like the pinned one. */
    expect(versionMatches({ ...A_RELEASE, version: '' }, 'ffmpeg version 7.1.1')).toBe(false)
  })

  test('empty output is not a match', () => {
    expect(versionMatches(A_RELEASE, '')).toBe(false)
  })
})

describe('where it comes from', () => {
  test('the mirror sits under the admin API this tool is pointed at', () => {
    /** So a tool pointed at staging downloads staging's copy rather than
     *  production's. */
    expect(mirrorUrl('https://admin-api.example.com', A_RELEASE)).toBe(
      'https://admin-api.example.com/tools/ffmpeg/ffmpeg-7.1.1-win64-gpl.zip',
    )
  })
})
