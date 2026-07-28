import { useEffect, useRef } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

import { Button } from './Button'
import { Menu } from './Menu'
import { visibleColumns, type ColumnSpec } from './columns'

/**
 * The back office's list: chosen columns, a checkbox per row, and one `⋯`
 * menu holding what that row can do.
 *
 * It knows nothing about orders or products. Everything specific arrives as
 * `render` on a column or as the menu's children, which is what stops a
 * generic table from slowly growing a branch per page.
 *
 * Selection is a list of keys held by the page, not by the table. The page is
 * the one that reloads, and a selection the table owned would survive a reload
 * that removed the rows it pointed at.
 */

export interface Column<T> extends ColumnSpec {
  render: (row: T) => ComponentChildren
}

interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  /** Column keys switched off in the chooser. */
  hidden?: string[]
  /** Present means "this list has checkboxes". */
  selected?: string[]
  onSelectedChange?: (keys: string[]) => void
  /** The contents of this row's `⋯` menu. Nothing back means no menu. */
  menu?: (row: T) => ComponentChildren
  rowClass?: (row: T) => string
  /** Shown instead of the table when there is nothing. Usually an EmptyState. */
  empty: ComponentChildren
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  hidden = [],
  selected,
  onSelectedChange,
  menu,
  rowClass,
  empty,
}: DataTableProps<T>) {
  const shown = visibleColumns(columns, hidden)
  const selectable = selected !== undefined && onSelectedChange !== undefined
  const chosen = new Set(selected ?? [])
  const keys = rows.map(rowKey)
  // Only what is on screen counts. "Select all" that quietly took rows a
  // filter had removed would be a bulk delete nobody could see the extent of.
  const allChosen = keys.length > 0 && keys.every((key) => chosen.has(key))
  const someChosen = keys.some((key) => chosen.has(key))

  if (rows.length === 0) return <>{empty}</>

  return (
    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            {selectable && (
              <th class="ui-table-check">
                <HeadCheck
                  checked={allChosen}
                  indeterminate={someChosen && !allChosen}
                  onChange={(next) => onSelectedChange?.(next ? keys : [])}
                />
              </th>
            )}
            {shown.map((column) => (
              <th key={column.key} class={column.numeric ? 'numeric' : undefined}>
                {column.label}
              </th>
            ))}
            {menu && <th class="ui-table-menu" aria-label="動作" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            const isChosen = chosen.has(key)
            return (
              <tr key={key} class={[rowClass?.(row) ?? '', isChosen ? 'is-selected' : ''].filter(Boolean).join(' ')}>
                {selectable && (
                  <td class="ui-table-check">
                    <RowCheck
                      label={key}
                      checked={isChosen}
                      onChange={(next) =>
                        onSelectedChange?.(next ? [...(selected ?? []), key] : (selected ?? []).filter((k) => k !== key))
                      }
                    />
                  </td>
                )}
                {shown.map((column) => (
                  <td key={column.key} class={column.numeric ? 'numeric' : undefined}>
                    {column.render(row)}
                  </td>
                ))}
                {menu && (
                  <td class="ui-table-menu">
                    <Menu label="這一列的動作">{menu(row)}</Menu>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * "Some but not all" is a third state, and only the DOM property can say it —
 * there is no attribute for it, so it has to be set after the render.
 */
function HeadCheck({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  onChange: (checked: boolean) => void
}) {
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <input
      ref={box}
      type="checkbox"
      class="ui-row-check"
      checked={checked}
      aria-label={checked ? '取消選取這一頁' : '選取這一頁'}
      onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
    />
  )
}

function RowCheck({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      class="ui-row-check"
      checked={checked}
      aria-label={`選取 ${label}`}
      onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
    />
  )
}

/**
 * The bar that appears once something is ticked.
 *
 * It says how many, because "刪除" over an invisible selection is how people
 * delete twelve things while thinking about one.
 */
export function BulkBar({
  count,
  onClear,
  children,
}: {
  count: number
  onClear: () => void
  children: ComponentChildren
}) {
  if (count === 0) return null
  return (
    <div class="ui-bulk-bar" role="region" aria-label="批次操作">
      <strong class="ui-bulk-count">已選取 {count} 筆</strong>
      <div class="ui-bulk-actions">{children}</div>
      <Button size="sm" tone="ghost" onClick={onClear}>
        取消選取
      </Button>
    </div>
  )
}

/** The row above a list: search on the left, filters and columns on the right. */
export function Toolbar({ children }: { children: ComponentChildren }) {
  return <div class="ui-toolbar">{children}</div>
}
