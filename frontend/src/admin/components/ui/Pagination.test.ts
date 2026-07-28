import { describe, expect, it } from 'vitest'

import { pageNumbers } from './Pagination'

/**
 * Seventy page buttons is not navigation. What the window has to guarantee is
 * that the first and last pages are always one click away, and that where you
 * are is always in the middle of a run you can step through.
 */

describe('the page window', () => {
  it('lists every page when they all fit', () => {
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('keeps the first and last reachable from the middle', () => {
    const shown = pageNumbers(20, 40)
    expect(shown[0]).toBe(1)
    expect(shown[shown.length - 1]).toBe(40)
    expect(shown).toContain(20)
  })

  it('marks the parts it skipped', () => {
    expect(pageNumbers(20, 40)).toEqual([1, 'gap', 18, 19, 20, 21, 22, 'gap', 40])
  })

  it('spells out a gap of exactly one rather than hiding it', () => {
    // The ellipsis would be wider than the single number it replaces.
    expect(pageNumbers(4, 40)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 40])
  })

  it('never repeats a page', () => {
    for (let page = 1; page <= 12; page += 1) {
      const shown = pageNumbers(page, 12).filter((entry) => entry !== 'gap')
      expect(new Set(shown).size).toBe(shown.length)
    }
  })

  it('stays in order', () => {
    const shown = pageNumbers(7, 30).filter((entry): entry is number => entry !== 'gap')
    expect([...shown].sort((left, right) => left - right)).toEqual(shown)
  })

  it('handles a single page without inventing neighbours', () => {
    expect(pageNumbers(1, 1)).toEqual([1])
  })

  it('does not run past the end when the current page is the last one', () => {
    expect(pageNumbers(40, 40)).toEqual([1, 'gap', 38, 39, 40])
  })
})
