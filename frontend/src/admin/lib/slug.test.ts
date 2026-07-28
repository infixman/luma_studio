import { describe, expect, it } from 'vitest'

import { followsTitle, nextPath, suggestPath } from './slug'

describe('suggestPath', () => {
  it('makes a path out of a latin title', () => {
    expect(suggestPath('About Us')).toBe('/about-us')
    expect(suggestPath('  Gift Sets 2026  ')).toBe('/gift-sets-2026')
  })

  it('answers with nothing when the title holds nothing a URL can carry', () => {
    expect(suggestPath('關於我們')).toBe('')
    expect(suggestPath('———')).toBe('')
    expect(suggestPath('')).toBe('')
  })
})

describe('nextPath', () => {
  it('follows the title while the lock is shut', () => {
    expect(nextPath('/about', 'About Us', true)).toBe('/about-us')
  })

  /* The drift this whole feature is about: the path used to be suggested once
     and then sat there, describing the page's old name. */
  it('keeps following as the title keeps changing', () => {
    let path = ''
    for (const title of ['A', 'Ab', 'About', 'About Us']) path = nextPath(path, title, true)
    expect(path).toBe('/about-us')
  })

  it('stops following the moment the lock is opened', () => {
    expect(nextPath('/gifts', 'About Us', false)).toBe('/gifts')
  })

  /* A Chinese title suggests nothing, and nothing must not clear a path that
     works — otherwise editing the title of a page called 關於我們 would empty
     its address while the owner was still typing. */
  it('leaves the path alone when the title suggests nothing', () => {
    expect(nextPath('/about', '關於我們', true)).toBe('/about')
    expect(nextPath('/about', '', true)).toBe('/about')
  })
})

describe('followsTitle', () => {
  it('recognises a path that came from the title', () => {
    expect(followsTitle('About Us', '/about-us')).toBe(true)
  })

  it('does not claim a hand-typed path is following', () => {
    expect(followsTitle('About Us', '/about')).toBe(false)
    // The published address of a page with a Chinese title was typed by hand
    // by definition, so its lock has to start open.
    expect(followsTitle('關於我們', '/about')).toBe(false)
  })

  it('does not treat two empties as a match', () => {
    expect(followsTitle('關於我們', '')).toBe(false)
  })
})
