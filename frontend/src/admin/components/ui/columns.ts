/**
 * Which columns a list shows, remembered per page.
 *
 * What is stored is the **hidden** set, not the visible one. Two things fall
 * out of that and neither works the other way round: a column added to the
 * table after somebody made a choice shows up, instead of being invisible
 * forever with nothing on screen to explain it; and a column that has since
 * been removed from the table leaves nothing behind but a dead key.
 *
 * A back office has columns that cannot be dropped — an order id, the name of
 * the thing the row is about. Those are marked `fixed`, are never offered in
 * the chooser, and survive a storage entry that names them anyway.
 */

export interface ColumnSpec {
  key: string
  label: string
  /** Never offered, never hidden. */
  fixed?: boolean
  /** Right-aligned, tabular figures — money and counts. */
  numeric?: boolean
}

import { read, write } from '../../lib/storage'

/**
 * One key per page, under the back office's single naming scheme.
 *
 * Exported so a test can plant a malformed value without hard-coding the key
 * — which it did, and which turned a rename into a failing test rather than
 * the behaviour change it was.
 */
export const columnsName = (page: string) => `columns-${page}`

/**
 * What this page has hidden, or `null` when nobody has ever said.
 *
 * The two are not the same and the difference is a real bug if flattened: a
 * page whose default hides four rarely-read columns has to be able to tell
 * "never chosen" from "chosen, and the choice was to show everything".
 * Written as `readHidden(page) ?? DEFAULTS` at every call site.
 */
export function readHidden(page: string): string[] | null {
  const raw = read(columnsName(page))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((key): key is string => typeof key === 'string')
  } catch {
    // Something else wrote here, or a half-written value survived a crash.
    // Falling back to the defaults beats refusing to draw the table.
    return null
  }
}

export function writeHidden(page: string, hidden: string[]): void {
  // An empty list is written rather than removed, because removing it would
  // read back as "never chosen" and hand the defaults to somebody who has
  // just deliberately switched every column on.
  write(columnsName(page), JSON.stringify(hidden))
}

/** The columns actually drawn, in the table's own order. */
export function visibleColumns<C extends ColumnSpec>(columns: C[], hidden: string[]): C[] {
  const off = new Set(hidden)
  return columns.filter((column) => column.fixed || !off.has(column.key))
}

/** What the chooser offers: everything that is allowed to disappear. */
export function choosableColumns<C extends ColumnSpec>(columns: C[]): C[] {
  return columns.filter((column) => !column.fixed)
}

/**
 * Flip one column, refusing to hide a fixed one even if asked.
 *
 * The result is filtered back down to keys the table still has, so a stale
 * entry cannot accumulate forever in somebody's browser.
 */
export function toggleHidden(columns: ColumnSpec[], hidden: string[], key: string): string[] {
  const known = new Map(columns.map((column) => [column.key, column]))
  const next = new Set(hidden.filter((entry) => known.get(entry) && !known.get(entry)?.fixed))
  const column = known.get(key)
  if (!column || column.fixed) return [...next]
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return [...next]
}
