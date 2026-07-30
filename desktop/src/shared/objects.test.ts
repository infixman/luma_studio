import { describe, expect, test } from 'vitest'

import {
  batched,
  contentTypeFor,
  isEncodeObject,
  objectKey,
  toPosix,
  uploadOrder,
  RENDITIONS,
} from './objects'

describe('what counts as part of an encode', () => {
  test.each([
    'master.m3u8',
    'poster.webp',
    '720p/playlist.m3u8',
    '720p/init.mp4',
    '1080p/segment-000001.m4s',
    '480p/segment-999999.m4s',
  ])('%s is', (path) => {
    expect(isEncodeObject(path)).toBe(true)
  })

  test.each([
    '',
    'notes.txt',
    'source.mp4',
    '720p/notes.txt',
    '999p/playlist.m3u8',
    '720p/segment-1.m4s',
    '720p/segment-1234567.m4s',
    '../master.m3u8',
    'sub/720p/init.mp4',
  ])('%s is not', (path) => {
    expect(isEncodeObject(path)).toBe(false)
  })

  test('every rung of the ladder is recognised', () => {
    /** The shapes are built from RENDITIONS rather than repeating it, so adding
     *  a rung cannot leave one of them behind. */
    for (const rendition of RENDITIONS) {
      expect(isEncodeObject(`${rendition}/playlist.m3u8`)).toBe(true)
      expect(isEncodeObject(`${rendition}/segment-000001.m4s`)).toBe(true)
    }
  })

  test('a Windows path is understood', () => {
    /** This comes from a directory walk on Windows. */
    expect(isEncodeObject('720p\\init.mp4')).toBe(true)
  })

  test('a leading separator normalises rather than being refused', () => {
    /** `objectKey` strips it too, and the two have to agree: a check that
     *  refused what the key builder accepts would let a caller build a key for
     *  something it had just rejected. */
    expect(isEncodeObject('/master.m3u8')).toBe(true)
  })
})

describe('content types', () => {
  test('a playlist is a playlist', () => {
    /** Sent as octet-stream it is a playlist no player will read, and R2 keeps
     *  whatever the PUT said — so this is the only chance to get it right. */
    expect(contentTypeFor('master.m3u8')).toBe('application/vnd.apple.mpegurl')
  })

  test('a segment and its init have video types', () => {
    expect(contentTypeFor('segment-000001.m4s')).toBe('video/iso.segment')
    expect(contentTypeFor('init.mp4')).toBe('video/mp4')
  })

  test('the poster is a webp', () => {
    expect(contentTypeFor('poster.webp')).toBe('image/webp')
  })

  test('case does not matter', () => {
    expect(contentTypeFor('MASTER.M3U8')).toBe('application/vnd.apple.mpegurl')
  })
})

describe('keys', () => {
  test('a key is the encode prefix plus the relative path', () => {
    expect(objectKey('asset-1', 2, '720p/init.mp4')).toBe('videos/asset-1/2/720p/init.mp4')
  })

  test('a Windows separator becomes a slash', () => {
    /** A backslash in an object key is a different object, and one the server
     *  will refuse. */
    expect(objectKey('asset-1', 2, '720p\\init.mp4')).toBe('videos/asset-1/2/720p/init.mp4')
  })

  test('a leading separator does not double the slash', () => {
    expect(objectKey('asset-1', 2, '/master.m3u8')).toBe('videos/asset-1/2/master.m3u8')
  })

  test('toPosix leaves an already clean path alone', () => {
    expect(toPosix('720p/init.mp4')).toBe('720p/init.mp4')
  })
})

describe('the order things are uploaded in', () => {
  test('the master goes last', () => {
    /** Registration reads it first, so an interrupted upload is refused with
     *  "the master is missing" — one sentence — rather than a list of three
     *  hundred absent segments, which is the same fact told uselessly. */
    const order = uploadOrder(['master.m3u8', '720p/init.mp4', '720p/segment-000001.m4s'])

    expect(order.at(-1)).toBe('master.m3u8')
  })

  test('the rest is sorted, so a run is reproducible', () => {
    const order = uploadOrder(['720p/segment-000002.m4s', '720p/init.mp4', '720p/segment-000001.m4s'])

    expect(order).toEqual([
      '720p/init.mp4',
      '720p/segment-000001.m4s',
      '720p/segment-000002.m4s',
    ])
  })

  test('nothing is dropped or duplicated', () => {
    const paths = ['master.m3u8', 'poster.webp', '480p/playlist.m3u8']

    expect(uploadOrder(paths).sort()).toEqual([...paths].sort())
  })

  test('a folder with no master still works', () => {
    /** Re-uploading only the objects a verification said were missing. */
    expect(uploadOrder(['720p/init.mp4'])).toEqual(['720p/init.mp4'])
  })
})

describe('batching', () => {
  test('a short list is one batch', () => {
    expect(batched([1, 2, 3], 100)).toEqual([[1, 2, 3]])
  })

  test('an exact multiple does not produce an empty tail', () => {
    expect(batched([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })

  test('a remainder gets its own batch', () => {
    expect(batched([1, 2, 3], 2)).toEqual([[1, 2], [3]])
  })

  test('an empty list is no batches', () => {
    expect(batched([], 10)).toEqual([])
  })

  test('a size of zero is refused rather than looping forever', () => {
    expect(() => batched([1], 0)).toThrow()
  })
})
