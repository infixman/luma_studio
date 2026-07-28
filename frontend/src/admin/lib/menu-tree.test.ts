import { describe, expect, it } from 'vitest'

import { canIndent, canOutdent, drop, flatten, indent, move, outdent, toOrder } from './menu-tree'
import type { Row } from './menu-tree'
import type { MenuItem } from '../../shared/types'

/**
 * The menu as a tree of labels, for tests that read like the thing on screen:
 *
 *   ['about', ['courses', ['kits', ['piping']]]]
 */
type Sketch = [string, ...Sketch[]]

function build(sketch: Sketch[]): MenuItem[] {
  const items: MenuItem[] = []
  const walk = (nodes: Sketch[], parentId: string | null) => {
    nodes.forEach(([label, ...children], position) => {
      items.push({
        id: label,
        parentId,
        label,
        targetKind: 'url',
        target: `https://example.com/${label}`,
        position,
      })
      walk(children, label)
    })
  }
  walk(sketch, null)
  return items
}

/** Rows as `depth:label`, which is what the editor draws. */
const shape = (rows: Row[] | null) => (rows ?? []).map((row) => `${row.depth}:${row.item.id}`)

const MENU = build([['about'], ['courses', ['kits', ['piping']], ['gifts']], ['contact']])
const rows = () => flatten(MENU)
const at = (id: string) => rows().findIndex((row) => row.item.id === id)

describe('flatten', () => {
  it('draws children under their parent, in position order', () => {
    expect(shape(rows())).toEqual([
      '1:about',
      '1:courses',
      '2:kits',
      '3:piping',
      '2:gifts',
      '1:contact',
    ])
  })

  it('sorts siblings by position rather than by the order they arrived', () => {
    const scrambled = [...MENU].reverse()
    expect(shape(flatten(scrambled))).toEqual(shape(rows()))
  })

  it('still draws an item whose parent is missing', () => {
    const orphan: MenuItem = { id: 'x', parentId: 'gone', label: 'x', targetKind: 'url', target: '/', position: 0 }
    expect(shape(flatten([...MENU, orphan]))).toContain('1:x')
  })
})

describe('indent', () => {
  it('makes an item a child of the row above it', () => {
    expect(shape(indent(rows(), at('gifts')))).toEqual([
      '1:about',
      '1:courses',
      '2:kits',
      '3:piping',
      '3:gifts',
      '1:contact',
    ])
  })

  it('carries the item’s own children down with it', () => {
    const menu = flatten(build([['a'], ['b', ['b1']]]))
    expect(shape(indent(menu, 1))).toEqual(['1:a', '2:b', '3:b1'])
  })

  it('refuses when a descendant would end up past the third level', () => {
    // `courses` is at level 1 but reaches level 3 through `piping`, so moving
    // it under `about` would push a grandchild to level 4.
    expect(canIndent(rows(), at('courses'))).toBe(false)
    expect(indent(rows(), at('courses'))).toBeNull()
  })

  it('refuses at the third level', () => {
    expect(canIndent(rows(), at('piping'))).toBe(false)
  })

  it('refuses for the first row, which has nothing to become a child of', () => {
    expect(canIndent(rows(), 0)).toBe(false)
  })

  it('refuses when the row above is shallower than the item', () => {
    // `kits` sits directly under `courses`; there is no sibling above it.
    expect(canIndent(rows(), at('kits'))).toBe(false)
  })
})

describe('outdent', () => {
  it('lifts an item and its children one level', () => {
    expect(shape(outdent(rows(), at('kits')))).toEqual([
      '1:about',
      '1:courses',
      '1:kits',
      '2:piping',
      '2:gifts',
      '1:contact',
    ])
  })

  it('refuses at the top level', () => {
    expect(canOutdent(rows(), at('about'))).toBe(false)
    expect(outdent(rows(), at('about'))).toBeNull()
  })
})

describe('move', () => {
  it('steps over the neighbour’s whole subtree rather than into it', () => {
    expect(shape(move(rows(), at('about'), 1))).toEqual([
      '1:courses',
      '2:kits',
      '3:piping',
      '2:gifts',
      '1:about',
      '1:contact',
    ])
  })

  it('takes the item’s children along', () => {
    expect(shape(move(rows(), at('kits'), 1))).toEqual([
      '1:about',
      '1:courses',
      '2:gifts',
      '2:kits',
      '3:piping',
      '1:contact',
    ])
  })

  it('moves back up past a whole subtree', () => {
    expect(shape(move(rows(), at('contact'), -1))).toEqual([
      '1:about',
      '1:contact',
      '1:courses',
      '2:kits',
      '3:piping',
      '2:gifts',
    ])
  })

  it('refuses to move past the first sibling, which would escape the parent', () => {
    expect(move(rows(), at('kits'), -1)).toBeNull()
  })

  it('refuses to move past the last sibling', () => {
    expect(move(rows(), at('gifts'), 1)).toBeNull()
    expect(move(rows(), at('contact'), 1)).toBeNull()
    expect(move(rows(), 0, -1)).toBeNull()
  })
})

describe('drop', () => {
  it('lands the block above the row it was released on, keeping its level', () => {
    expect(shape(drop(rows(), at('contact'), 'courses'))).toEqual([
      '1:about',
      '1:contact',
      '1:courses',
      '2:kits',
      '3:piping',
      '2:gifts',
    ])
  })

  it('raises a block that lands somewhere too shallow for its level', () => {
    // `gifts` is at level 2; dropped at the very top there is no parent above
    // it, so it rises rather than being drawn deeper than its parent.
    expect(shape(drop(rows(), at('gifts'), 'about'))).toEqual([
      '1:gifts',
      '1:about',
      '1:courses',
      '2:kits',
      '3:piping',
      '1:contact',
    ])
  })

  it('raises the children by the same amount, keeping the shape', () => {
    expect(shape(drop(rows(), at('kits'), 'about'))).toEqual([
      '1:kits',
      '2:piping',
      '1:about',
      '1:courses',
      '2:gifts',
      '1:contact',
    ])
  })

  it('refuses a drop onto the block’s own descendant', () => {
    expect(drop(rows(), at('courses'), 'piping')).toBeNull()
  })

  it('refuses a drop onto a row that is not there', () => {
    expect(drop(rows(), 0, 'nonsense')).toBeNull()
  })
})

describe('toOrder', () => {
  it('turns depth back into parentage', () => {
    expect(toOrder(rows())).toEqual([
      { id: 'about', parentId: null },
      { id: 'courses', parentId: null },
      { id: 'kits', parentId: 'courses' },
      { id: 'piping', parentId: 'kits' },
      { id: 'gifts', parentId: 'courses' },
      { id: 'contact', parentId: null },
    ])
  })

  it('reparents whatever the move left behind', () => {
    expect(toOrder(indent(rows(), at('gifts'))!)).toContainEqual({ id: 'gifts', parentId: 'kits' })
  })

  it('survives a round trip through the flat list', () => {
    const order = toOrder(rows())
    const reordered = order.map((entry, position) => ({
      ...MENU.find((item) => item.id === entry.id)!,
      parentId: entry.parentId,
      position,
    }))
    expect(shape(flatten(reordered))).toEqual(shape(rows()))
  })
})
