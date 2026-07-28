import { describe, expect, it } from 'vitest'

import { SIZE_TARGETS, planSizes, scaledHeight } from './mediaResize'

/* The maths, not the drawing. A wrong height is invisible — the picture still
   appears, only slightly squashed — which is exactly the kind of mistake that
   ships. */

describe('planSizes', () => {
  it('leaves out every target that would scale the image up', () => {
    // 1024 wide: 480 and 960 are narrower, 1600 would be an enlargement.
    expect(planSizes(1024, 1024).map((size) => size.label)).toEqual(['small', 'medium'])
  })

  it('plans nothing for an image already narrower than the smallest target', () => {
    expect(planSizes(400, 300)).toEqual([])
  })

  it('treats a target equal to the original as an enlargement too', () => {
    // Re-encoding 480 as 480 is a second copy of the same picture.
    expect(planSizes(480, 480)).toEqual([])
  })

  it('keeps the aspect ratio of a landscape image', () => {
    expect(planSizes(3000, 2000)).toEqual([
      { label: 'small', width: 480, height: 320 },
      { label: 'medium', width: 960, height: 640 },
      { label: 'large', width: 1600, height: 1067 },
    ])
  })

  it('keeps the aspect ratio of a portrait image', () => {
    // The target is a width, so a portrait photo stays taller than it is wide.
    expect(planSizes(800, 1200)).toEqual([{ label: 'small', width: 480, height: 720 }])
  })

  it('never plans a height of zero', () => {
    // A canvas of height 0 throws; a one pixel banner is at least drawable.
    // 3px tall at 2000 wide rounds to 0.72 and 1.44 before it reaches 2.4.
    expect(planSizes(2000, 3).map((size) => size.height)).toEqual([1, 1, 2])
  })

  it('plans nothing for an image nobody could measure', () => {
    // createImageBitmap failed, so there are no pixels to draw from.
    expect(planSizes(0, 0)).toEqual([])
    expect(planSizes(Number.NaN, Number.NaN)).toEqual([])
  })

  it('hands the widths back narrowest first, the way a srcset is read', () => {
    const widths = planSizes(4000, 3000).map((size) => size.width)
    expect(widths).toEqual([...widths].sort((first, second) => first - second))
    expect(widths).toEqual(SIZE_TARGETS.map((target) => target.width))
  })
})

describe('scaledHeight', () => {
  it('rounds to the nearest pixel rather than truncating', () => {
    // 333 * 480 / 1000 = 159.84, which truncation would call 159.
    expect(scaledHeight(1000, 333, 480)).toBe(160)
  })

  it('is exact when the ratio divides evenly', () => {
    expect(scaledHeight(1000, 500, 480)).toBe(240)
  })

  it('floors at one pixel', () => {
    expect(scaledHeight(2000, 1, 480)).toBe(1)
  })

  it('stays within a pixel of the original ratio', () => {
    for (const [width, height] of [
      [4032, 3024],
      [1080, 1920],
      [777, 313],
      [2560, 1440],
    ] as const) {
      for (const target of SIZE_TARGETS.map((size) => size.width)) {
        const scaled = scaledHeight(width, height, target)
        expect(Math.abs(scaled / target - height / width)).toBeLessThan(1 / target)
      }
    }
  })
})

