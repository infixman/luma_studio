import { describe, expect, it } from 'vitest'

import { parseCopiedBlock, serialiseBlock } from './blockClipboard'
import type { CopiedBlock } from './blockClipboard'
import type { TextBlockConfig } from '../../shared/types'

/** What this build knows how to edit and render. The paste is checked against it. */
const KNOWN = ['text', 'carousel', 'album', 'shop', 'about'] as const

const TEXT: CopiedBlock = { type: 'text', config: { body: '# 條款\n\n第一段。' } }

describe('serialiseBlock / parseCopiedBlock', () => {
  it('carries the type and the config through', () => {
    const back = parseCopiedBlock(serialiseBlock(TEXT), KNOWN)
    expect(back?.type).toBe('text')
    expect((back?.config as TextBlockConfig).body).toBe('# 條款\n\n第一段。')
  })

  it('keeps a nested config intact', () => {
    const album: CopiedBlock = { type: 'album', config: { mediaIds: ['a', 'b'], columns: 3, ratio: 'square' } }
    expect(parseCopiedBlock(serialiseBlock(album), KNOWN)?.config).toEqual(album.config)
  })

  it('does not carry an id or a position, because a paste makes a new block', () => {
    const stored = JSON.parse(serialiseBlock(TEXT)) as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['config', 'type', 'v'])
  })
})

describe('parseCopiedBlock refuses what it cannot use', () => {
  /* The case this whole check exists for: the clipboard outlives a deploy, so
     a block copied from a newer build can arrive at an older one. Pasting it
     would create a row with no editor and no renderer. */
  it('refuses a type this build does not know', () => {
    const future = JSON.stringify({ v: 1, type: 'video', config: { src: 'x' } })
    expect(parseCopiedBlock(future, KNOWN)).toBeNull()
  })

  it('refuses a type that is known to the store but not to this caller', () => {
    // The same guard protects a narrower list — a picker offering only three
    // types must not accept a paste of the other two.
    expect(parseCopiedBlock(serialiseBlock(TEXT), ['carousel', 'album'])).toBeNull()
  })

  it('refuses an entry written by a different version of the format', () => {
    expect(parseCopiedBlock(JSON.stringify({ v: 2, type: 'text', config: { body: '' } }), KNOWN)).toBeNull()
    expect(parseCopiedBlock(JSON.stringify({ type: 'text', config: { body: '' } }), KNOWN)).toBeNull()
  })

  it('refuses an empty clipboard', () => {
    expect(parseCopiedBlock(null, KNOWN)).toBeNull()
    expect(parseCopiedBlock('', KNOWN)).toBeNull()
  })

  it('refuses anything that is not the shape it wrote', () => {
    expect(parseCopiedBlock('not json', KNOWN)).toBeNull()
    expect(parseCopiedBlock('null', KNOWN)).toBeNull()
    expect(parseCopiedBlock('[]', KNOWN)).toBeNull()
    expect(parseCopiedBlock(JSON.stringify({ v: 1, type: 'text' }), KNOWN)).toBeNull()
    expect(parseCopiedBlock(JSON.stringify({ v: 1, type: 'text', config: 'body' }), KNOWN)).toBeNull()
    expect(parseCopiedBlock(JSON.stringify({ v: 1, type: 'text', config: [] }), KNOWN)).toBeNull()
    expect(parseCopiedBlock(JSON.stringify({ v: 1, type: 42, config: {} }), KNOWN)).toBeNull()
  })
})
