import { describe, expect, it } from 'vitest'

import { fileSize } from './bytes'

describe('fileSize', () => {
  it('bytes stay bytes', () => {
    expect(fileSize(900)).toBe('900 B')
  })

  it('kilobytes are whole', () => {
    expect(fileSize(2048)).toBe('2 KB')
  })

  it('megabytes carry one decimal', () => {
    expect(fileSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })

  it('a video is described in gigabytes rather than four figures of megabytes', () => {
    /** This function was written for images, where megabytes is the top of the
     *  range. A course video is a few gigabytes, and "2048.0 MB" is a number the
     *  reader has to convert before it means anything. */
    expect(fileSize(1024 * 1024 * 1024 * 2)).toBe('2.0 GB')
  })

  it('the boundary belongs to the smaller unit', () => {
    expect(fileSize(1024 * 1024 * 1024 - 1)).toContain('MB')
  })
})
