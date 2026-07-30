import { describe, expect, test } from 'vitest'

import { looksLikeSource } from './sourceKinds'

describe('telling a video file from a folder', () => {
  test.each(['a.mp4', 'C:\\videos\\lesson 01.MP4', '/x/y.mov', 'z.mkv', 'w.m4v'])(
    '%s looks like a source',
    (path) => {
      expect(looksLikeSource(path)).toBe(true)
    },
  )

  test.each(['C:\\encodes\\asset-one\\v1', 'master.m3u8', 'poster.webp', 'folder', ''])(
    '%s does not',
    (path) => {
      expect(looksLikeSource(path)).toBe(false)
    },
  )

  test('a folder whose name contains mp4 is not a source', () => {
    /** By extension, not by substring. */
    expect(looksLikeSource('C:\\mp4-exports')).toBe(false)
  })

  test('the guess only picks which path to try', () => {
    /** ffprobe decides whether the file is really a video, so being wrong here
     *  produces a proper refusal rather than a bad encode. */
    expect(looksLikeSource('not-really-a-video.mp4')).toBe(true)
  })
})
