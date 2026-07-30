import { describe, expect, test } from 'vitest'

import { etagOf, partRanges, remaining, shouldUploadSource } from './sourceUpload'

const MIB = 1024 * 1024

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

describe('cutting a file into parts', () => {
  test('every byte belongs to exactly one part', () => {
    const ranges = partRanges(300 * MIB, 64 * MIB)

    expect(ranges[0]!.start).toBe(0)
    expect(ranges.at(-1)!.end).toBe(300 * MIB)
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index]!.start).toBe(ranges[index - 1]!.end)
    }
  })

  test('part numbers start at one, as S3 requires', () => {
    /** A zero passes every naive check and fails at CompleteMultipartUpload,
     *  long after the bytes have been sent. */
    expect(partRanges(10 * MIB, 5 * MIB)[0]!.partNumber).toBe(1)
  })

  test('only the last part is short', () => {
    /** S3 refuses a short part anywhere else, and says so at the end of the
     *  upload rather than at the start. */
    const ranges = partRanges(130 * MIB, 64 * MIB)

    const lengths = ranges.map((range) => range.end - range.start)
    expect(lengths.slice(0, -1).every((length) => length === 64 * MIB)).toBe(true)
    expect(lengths.at(-1)).toBe(2 * MIB)
  })

  test('a file that fits in one part is one part', () => {
    expect(partRanges(3 * MIB, 64 * MIB)).toHaveLength(1)
  })

  test('a file whose size is an exact multiple has no empty last part', () => {
    /** `start < byteSize` rather than `start <= byteSize`: an empty final part
     *  is one R2 refuses, and it would be the last thing sent. */
    expect(partRanges(128 * MIB, 64 * MIB)).toHaveLength(2)
  })

  test.each([0, -1, 1.5, Number.NaN])('a size that is not one is refused: %s', (size) => {
    expect(() => partRanges(size, 64 * MIB)).toThrow()
  })

  test('a part size that is not one is refused', () => {
    expect(() => partRanges(10 * MIB, 0)).toThrow()
  })
})

describe('the tag a part came back with', () => {
  test('it is read from the response', () => {
    expect(etagOf(headers({ etag: '"9b2cf535f27731c974343645a3985328"' }), 1)).toBe(
      '"9b2cf535f27731c974343645a3985328"',
    )
  })

  test('a missing one is fatal here rather than at the end', () => {
    /** A part whose tag was not read cannot be named when the upload is
     *  completed, so the upload would fail after every byte had been sent. */
    expect(() => etagOf(headers({}), 7)).toThrow(/7/)
  })

  test('the header name is matched however it is cased', () => {
    expect(etagOf(headers({ etag: '"abc"' }), 1)).toBe('"abc"')
  })
})

describe('resuming inside a run', () => {
  test('parts already sent are not sent again', () => {
    const ranges = partRanges(300 * MIB, 64 * MIB)

    const left = remaining(ranges, new Set([1, 2]))

    expect(left.map((range) => range.partNumber)).toEqual([3, 4, 5])
  })

  test('nothing done means everything left', () => {
    const ranges = partRanges(10 * MIB, 5 * MIB)

    expect(remaining(ranges, new Set())).toHaveLength(2)
  })
})


describe('whether this run sends the original', () => {
  test('it does, for a job that started from a file', () => {
    expect(shouldUploadSource('C:/videos/lesson.mp4', undefined)).toBe(true)
  })

  test('it does not, when a previous run already sent it', () => {
    /** The server allows one source session per asset, so trying again is not
     *  wasted bandwidth — it is refused, and the whole job stops over a step
     *  that had already succeeded. */
    expect(shouldUploadSource('C:/videos/lesson.mp4', true)).toBe(false)
  })

  test('it does not, for a folder of finished output', () => {
    /** That entrance re-sends an encode somebody already made. There is no
     *  original in the job. */
    expect(shouldUploadSource(null, undefined)).toBe(false)
    expect(shouldUploadSource('', undefined)).toBe(false)
  })
})
