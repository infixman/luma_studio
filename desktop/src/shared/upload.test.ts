import { describe, expect, test } from 'vitest'

import { recordedByteSize } from './upload'

describe('which size the asset records', () => {
  test('the original, when the job started from a file', () => {
    /** The library calls that column 原始檔容量, and the server divides it into
     *  multipart parts — the encode total there is an upload that fails partway
     *  through, because the tool cut the real file a different way. */
    expect(recordedByteSize(4_000_000_000, 2_400_000_000)).toBe(4_000_000_000)
  })

  test('the encode total, when there is no original', () => {
    /** The folder-only entrance re-sends an encode somebody already made. */
    expect(recordedByteSize(null, 2_400_000_000)).toBe(2_400_000_000)
  })

  test('a zero is not a size', () => {
    expect(recordedByteSize(0, 2_400_000_000)).toBe(2_400_000_000)
  })
})
