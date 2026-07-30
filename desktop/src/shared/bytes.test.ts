import { describe, expect, test } from 'vitest'

import { fileSize } from './bytes'

describe('a size in the unit a reader can act on', () => {
  test('bytes stay bytes', () => {
    expect(fileSize(900)).toBe('900 B')
  })

  test('megabytes carry one decimal', () => {
    expect(fileSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })

  test('a finished encode is described in gigabytes', () => {
    /** `3072.4 MB` is a number the reader has to convert first. */
    expect(fileSize(1024 * 1024 * 1024 * 3)).toBe('3.0 GB')
  })

  test('a size that is not one says so rather than reading as zero', () => {
    expect(fileSize(Number.NaN)).toBe('—')
  })
})
