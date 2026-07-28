import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

import { BLOCK_KINDS, BlockIcon, blockSummary } from './BlockEditors'
import { IconButton } from './ui'
import type { BlockConfig, PageBlock } from '../../shared/types'

/**
 * One block in the page, collapsed to a single row until it is opened.
 *
 * A page here can hold eight blocks, and every one of them used to be fully
 * expanded at once — so finding the third carousel meant scrolling past two
 * of them. Collapsed, a block is a row that says what it is and what is in
 * it, which is enough to find the one you meant.
 *
 * Reordering is a drag handle rather than a pair of arrows. Arrows move one
 * step at a time and each step is a request; a drag says where the block
 * belongs and costs one.
 */

const LABEL = Object.fromEntries(BLOCK_KINDS.map((kind) => [kind.type, kind.label]))

export function BlockRow({
  block,
  config,
  open,
  dirty,
  onToggle,
  onDelete,
  onInsert,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
  children,
}: {
  block: PageBlock
  config: BlockConfig
  open: boolean
  /** Marked when this block holds changes that have not been saved. */
  dirty: boolean
  onToggle: () => void
  onDelete: () => void
  /** Where a new block should go relative to this one. */
  onInsert: (where: 'above' | 'below') => void
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  dragging: boolean
  children: ComponentChildren
}) {
  const [menu, setMenu] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setMenu(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu])

  return (
    <li
      class={['block-row', open ? 'is-open' : '', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ')}
      onDragOver={(event) => {
        event.preventDefault()
        onDragOver()
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
    >
      <div class="block-head">
        <button
          type="button"
          class="block-toggle"
          aria-expanded={open}
          onClick={onToggle}
          title={open ? '收合' : '展開'}
        >
          <svg class="block-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <span class="block-kind" aria-hidden="true">
          <BlockIcon type={block.type} />
        </span>

        <button type="button" class="block-name" onClick={onToggle}>
          <span class="kind-label">{LABEL[block.type] ?? block.type}</span>
          <span class="kind-summary">{blockSummary(block.type, config)}</span>
        </button>

        {dirty && (
          <span class="block-dirty" title="這個區塊有還沒儲存的修改">
            未儲存
          </span>
        )}

        <div class="block-actions" ref={wrap}>
          <IconButton label="刪除這個區塊" tone="danger" size="sm" onClick={onDelete}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
            </svg>
          </IconButton>

          {/* The handle, not the whole row: a draggable row cannot have text
              selected inside it, and these rows open into forms. */}
          <span
            class="block-grip"
            draggable
            role="button"
            tabIndex={0}
            aria-label="拖曳以調整順序"
            title="拖曳以調整順序"
            onDragStart={onDragStart}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="9" cy="6" r="1.4" />
              <circle cx="15" cy="6" r="1.4" />
              <circle cx="9" cy="12" r="1.4" />
              <circle cx="15" cy="12" r="1.4" />
              <circle cx="9" cy="18" r="1.4" />
              <circle cx="15" cy="18" r="1.4" />
            </svg>
          </span>

          <IconButton label="更多" size="sm" onClick={() => setMenu(!menu)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="1.4" />
              <circle cx="12" cy="12" r="1.4" />
              <circle cx="19" cy="12" r="1.4" />
            </svg>
          </IconButton>

          {menu && (
            <ul class="block-menu">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false)
                    onInsert('above')
                  }}
                >
                  在上方插入區塊
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false)
                    onInsert('below')
                  }}
                >
                  在下方插入區塊
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>

      {open && <div class="block-body">{children}</div>}
    </li>
  )
}

/**
 * The type chooser, opened where the new block will go.
 *
 * A grid of marks rather than a dropdown: five options all visible at once is
 * one glance, and a `<select>` renders its list with the operating system —
 * which is the look this whole rebuild is getting away from.
 */
export function BlockPicker({
  onPick,
  onCancel,
}: {
  onPick: (type: PageBlock['type']) => void
  onCancel: () => void
}) {
  return (
    <div class="block-picker">
      <div class="picker-head">
        <p>要加哪一種區塊？</p>
        <button type="button" class="picker-close" onClick={onCancel}>
          取消
        </button>
      </div>
      <ul class="picker-grid">
        {BLOCK_KINDS.map((kind) => (
          <li key={kind.type}>
            <button type="button" class="picker-tile" onClick={() => onPick(kind.type)}>
              <span class="tile-mark" aria-hidden="true">
                <BlockIcon type={kind.type} />
              </span>
              <span class="tile-label">{kind.label}</span>
              <span class="tile-hint">{kind.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
