import { useRef, useState } from 'preact/hooks'

import { IconButton, Menu, MenuItem as MenuAction } from './ui'
import { MAX_DEPTH, canIndent, canOutdent, drop, flatten, indent, move, outdent, toOrder } from '../lib/menu-tree'
import type { Row } from '../lib/menu-tree'
import type { MenuItem, MenuState } from '../../shared/types'

/**
 * The three-level menu, edited as a flat list with an indent level.
 *
 * Two gestures rather than one. Dragging moves an item up and down; buttons
 * change its level. Doing both by drag means deciding what a diagonal
 * movement meant from pixel positions, and getting that wrong reparents
 * something the owner was only trying to move past.
 *
 * The buttons are always present, not a small-screen fallback. Drag is
 * unusable from a keyboard, and it is the thing most likely to behave
 * differently on someone else's device — so it is the addition, and the
 * buttons are the floor.
 *
 * The arithmetic lives in ../lib/menu-tree; this is the drawing of it.
 */
export function MenuEditor({
  state,
  busy,
  onReorder,
  onEdit,
  onRemove,
}: {
  state: MenuState
  busy: boolean
  onReorder: (items: { id: string; parentId: string | null }[]) => void
  onEdit: (item: MenuItem) => void
  onRemove: (item: MenuItem) => void
}) {
  const rows = flatten(state.menu)
  const dragged = useRef<number | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  /** Send the whole arrangement: order and parentage move together. */
  function commit(next: Row[] | null) {
    if (next) onReorder(toOrder(next))
  }

  function describe(item: MenuItem): string {
    if (item.targetKind === 'parent') return '父選單（無連結）'
    if (item.targetKind === 'page') {
      const page = state.pages.find((entry) => entry.id === item.target)
      if (!page) return '⚠ 找不到頁面'
      return page.status === 'published' ? page.path : `${page.path}（草稿，前台看不到）`
    }
    if (item.targetKind === 'category') {
      const missing = item.target
        .replace(/\+/g, ',')
        .split(',')
        .filter((slug) => slug && !state.categories.some((entry) => entry.slug === slug))
      return missing.length ? `⚠ 找不到分類：${missing.join('、')}` : `/shop/c/${item.target}`
    }
    return item.target
  }

  if (rows.length === 0) return <p class="muted">選單還是空的。</p>

  return (
    <ul class="menu-tree">
      {rows.map((row, index) => {
        const hint = describe(row.item)
        return (
          <li
            key={row.item.id}
            class={[`depth-${row.depth}`, dropTarget === row.item.id ? 'drop-target' : ''].filter(Boolean).join(' ')}
            draggable
            onDragStart={() => {
              dragged.current = index
            }}
            onDragOver={(event) => {
              if (dragged.current === null) return
              event.preventDefault()
              setDropTarget(row.item.id)
            }}
            onDrop={(event) => {
              event.preventDefault()
              const from = dragged.current
              dragged.current = null
              setDropTarget(null)
              if (from === null || from === index) return
              commit(drop(rows, from, row.item.id))
            }}
            onDragEnd={() => {
              dragged.current = null
              setDropTarget(null)
            }}
          >
            <span class="grip" aria-hidden="true">
              ⠿
            </span>
            <span class="label">{row.item.label}</span>
            <code class={hint.startsWith('⚠') ? 'broken' : ''}>{hint}</code>
            {/* The four arrows stay on the row: they are the reason this
                editor exists, and burying "move up" one click deep would make
                reordering a list slower than editing one. Everything else
                folds into the menu, the same as every other list. */}
            <span class="controls">
              <IconButton label="上移" size="sm" disabled={busy} onClick={() => commit(move(rows, index, -1))}>
                <span aria-hidden="true">↑</span>
              </IconButton>
              <IconButton label="下移" size="sm" disabled={busy} onClick={() => commit(move(rows, index, 1))}>
                <span aria-hidden="true">↓</span>
              </IconButton>
              <IconButton
                label="升一層"
                size="sm"
                disabled={busy || !canOutdent(rows, index)}
                onClick={() => commit(outdent(rows, index))}
              >
                <span aria-hidden="true">⇤</span>
              </IconButton>
              <IconButton
                label={`降一層（成為上一項的子項目，最多 ${MAX_DEPTH} 層）`}
                size="sm"
                disabled={busy || !canIndent(rows, index)}
                onClick={() => commit(indent(rows, index))}
              >
                <span aria-hidden="true">⇥</span>
              </IconButton>
              <Menu label={`「${row.item.label}」的操作`}>
                <MenuAction disabled={busy} onClick={() => onEdit(row.item)}>
                  編輯
                </MenuAction>
                <MenuAction tone="danger" disabled={busy} onClick={() => onRemove(row.item)}>
                  刪除
                </MenuAction>
              </Menu>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
