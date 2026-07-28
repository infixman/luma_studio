import type { MenuItem } from '../../shared/types'

/**
 * Rearranging the menu, as pure functions over a flat list.
 *
 * The editor draws the menu as one list with an indent level rather than as
 * nested lists: an item and its position are then the same thing, and a move
 * is an array splice instead of a tree surgery. These live outside the
 * component because the interesting part is the arithmetic, and the
 * arithmetic is what gets a test.
 *
 * Every function returns a new arrangement or `null` when the move is not
 * allowed, so the caller never has to ask twice whether something happened.
 */

export const MAX_DEPTH = 3

export type Row = { item: MenuItem; depth: number }

/** The list as drawn: each item with the depth it sits at. */
export function flatten(items: MenuItem[]): Row[] {
  const byParent = new Map<string | null, MenuItem[]>()
  for (const item of items) {
    const siblings = byParent.get(item.parentId) ?? []
    siblings.push(item)
    byParent.set(item.parentId, siblings)
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.position - b.position)

  const out: Row[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const item of byParent.get(parentId) ?? []) {
      out.push({ item, depth })
      walk(item.id, depth + 1)
    }
  }
  walk(null, 1)
  // Anything whose parent is missing would be stranded by the walk. Drawing it
  // at the top beats dropping it silently from the editor.
  if (out.length < items.length) {
    const drawn = new Set(out.map((row) => row.item.id))
    for (const item of items) if (!drawn.has(item.id)) out.push({ item, depth: 1 })
  }
  return out
}

/** One past the last row nested under `index`, so a move takes its children. */
export function withDescendants(rows: Row[], index: number): number {
  const depth = rows[index]!.depth
  let end = index + 1
  while (end < rows.length && rows[end]!.depth > depth) end += 1
  return end
}

/** The deepest level inside an item's block — what limits an indent. */
function deepest(rows: Row[], index: number): number {
  const end = withDescendants(rows, index)
  let depth = rows[index]!.depth
  for (let position = index; position < end; position += 1) depth = Math.max(depth, rows[position]!.depth)
  return depth
}

function shift(rows: Row[], from: number, to: number, by: number): Row[] {
  return rows.map((row, position) => (position >= from && position < to ? { ...row, depth: row.depth + by } : row))
}

/**
 * An item can become a child of the row above it when that row is at its level
 * or deeper, and when its own descendants still fit — a two-level branch
 * cannot move under something that is already at level two.
 */
export function canIndent(rows: Row[], index: number): boolean {
  const row = rows[index]
  const previous = rows[index - 1]
  if (!row || !previous) return false
  return previous.depth >= row.depth && deepest(rows, index) + 1 <= MAX_DEPTH
}

export function indent(rows: Row[], index: number): Row[] | null {
  if (!canIndent(rows, index)) return null
  return shift(rows, index, withDescendants(rows, index), 1)
}

export function canOutdent(rows: Row[], index: number): boolean {
  return (rows[index]?.depth ?? 1) > 1
}

export function outdent(rows: Row[], index: number): Row[] | null {
  if (!canOutdent(rows, index)) return null
  return shift(rows, index, withDescendants(rows, index), -1)
}

/**
 * Move an item past its neighbour at the same level, carrying its children.
 * Stepping over the neighbour's whole block rather than its first row is what
 * stops a move past a parent from landing in the middle of its children.
 */
export function move(rows: Row[], index: number, by: -1 | 1): Row[] | null {
  const end = withDescendants(rows, index)
  const block = rows.slice(index, end)
  const rest = [...rows.slice(0, index), ...rows.slice(end)]
  const depth = block[0]!.depth

  let target: number
  if (by < 0) {
    let previous = -1
    for (let position = index - 1; position >= 0; position -= 1) {
      if (rest[position]!.depth <= depth) {
        previous = position
        break
      }
    }
    // Nothing above at this level, or the row above is a parent: the item is
    // already first among its siblings.
    if (previous < 0 || rest[previous]!.depth < depth) return null
    target = previous
  } else {
    const after = rest.findIndex((row, position) => position >= index && row.depth <= depth)
    if (after < 0 || rest[after]!.depth < depth) return null
    target = withDescendants(rest, after)
  }

  rest.splice(target, 0, ...block)
  return rest
}

/**
 * Drop a dragged block above the row it was released on.
 *
 * Dragging changes position, not level — deciding what a diagonal movement
 * meant from pixel positions is how a drag that was only meant to move
 * something past a parent ends up reparenting it. The one exception is a
 * landing spot too shallow for the level the block was at: rather than draw an
 * item deeper than its parent, the whole block rises by the difference.
 */
export function drop(rows: Row[], from: number, ontoId: string): Row[] | null {
  const end = withDescendants(rows, from)
  const block = rows.slice(from, end)
  if (block.some((row) => row.item.id === ontoId)) return null // onto itself or its own child

  const rest = [...rows.slice(0, from), ...rows.slice(end)]
  const target = rest.findIndex((row) => row.item.id === ontoId)
  if (target < 0) return null

  const above = rest[target - 1]
  const allowed = above ? Math.min(block[0]!.depth, above.depth + 1) : 1
  const by = allowed - block[0]!.depth
  rest.splice(target, 0, ...(by === 0 ? block : block.map((row) => ({ ...row, depth: row.depth + by }))))
  return rest
}

/** The arrangement as the API wants it: order carries position, depth carries parentage. */
export function toOrder(rows: Row[]): { id: string; parentId: string | null }[] {
  const parents: (string | null)[] = []
  return rows.map((row) => {
    parents[row.depth] = row.item.id
    return { id: row.item.id, parentId: row.depth === 1 ? null : (parents[row.depth - 1] ?? null) }
  })
}
