import { describe, expect, it } from 'vitest'

import { srcSetFor } from './srcset'

/**
 * The point of making narrower copies is that a phone asks for one, and the
 * only thing that makes that happen is the markup. These pin the two ways it
 * silently fails: forgetting the original, and emitting a srcset of one.
 */

const size = (label: 'small' | 'medium' | 'large', width: number) => ({
  label,
  path: `/media-assets/${label}.webp`,
  width,
  height: Math.round(width * 0.75),
  byteSize: width * 100,
})

describe('srcSetFor', () => {
  it('says nothing for a picture with no narrower copies', () => {
    // Every image uploaded before the widths existed is in this case, and a
    // one-entry srcset is what src already said.
    expect(srcSetFor({ path: '/media-assets/old.png', width: 1024, sizes: [] })).toBeUndefined()
    expect(srcSetFor({ path: '/media-assets/old.png' })).toBeUndefined()
  })

  it('offers every stored width', () => {
    const set = srcSetFor({ path: '/media-assets/o.png', width: 4000, sizes: [size('small', 480), size('medium', 960)] })
    expect(set).toContain('480w')
    expect(set).toContain('960w')
  })

  it('keeps the original as the widest candidate', () => {
    // The stored widths stop below the original's own, so without it a large
    // screen would be handed the 1600px copy of a 4000px scan.
    const set = srcSetFor({ path: '/media-assets/o.png', width: 4000, sizes: [size('large', 1600)] })
    expect(set).toContain('/media-assets/o.png 4000w')
  })

  it('leaves the original out when its width was never measured', () => {
    // Zero is what a pre-migration row carries, and "0w" would be a candidate
    // the browser could pick.
    const set = srcSetFor({ path: '/media-assets/o.png', width: 0, sizes: [size('small', 480)] })
    // Named by its path, not by "0w": 480w contains that as a substring.
    expect(set).not.toContain('/media-assets/o.png')
    expect(set).toContain('480w')
  })
})
