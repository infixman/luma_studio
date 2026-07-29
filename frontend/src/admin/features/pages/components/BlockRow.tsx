import type { ComponentChildren } from 'preact'

import { BLOCK_KINDS, BlockIcon, blockSummary } from '../blocks/BlockEditor'
import { IconButton, Menu, MenuGroup, MenuItem } from '../../../components/ui'
import type { BlockConfig, PageBlock } from '../../../../shared/types'

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
 *
 * The ⋯ menu holds the three gestures that are about this block rather than
 * about the page: duplicate it, copy it somewhere else, paste something here.
 * Copy and paste go through storage rather than through this component,
 * because the page they are for is the other one.
 */

const LABEL = Object.fromEntries(BLOCK_KINDS.map((kind) => [kind.type, kind.label]))

export function BlockRow({
  block,
  config,
  position,
  domId,
  open,
  dirty,
  onToggle,
  onDelete,
  onInsert,
  onDuplicate,
  onCopy,
  onPaste,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  dragging,
  children,
}: {
  block: PageBlock
  config: BlockConfig
  /** Where this row sits, counting from one. Drawn as 01, 02, 03. */
  position: number
  /** The row's anchor, so the preview can scroll to the block that was clicked. */
  domId: string
  open: boolean
  /** Marked when this block holds changes that have not been saved. */
  dirty: boolean
  onToggle: () => void
  onDelete: () => void
  /** Where a new block should go relative to this one. */
  onInsert: (where: 'above' | 'below') => void
  /** Same type, same config, directly below this one. */
  onDuplicate: () => void
  onCopy: () => void
  /** Null when there is nothing to paste, or when what is there is a type this build cannot use. */
  onPaste: (() => void) | null
  onDragStart: () => void
  onDragOver: () => void
  /** The drag finished, however it finished — including cancelled. */
  onDragEnd: () => void
  onDrop: () => void
  dragging: boolean
  children: ComponentChildren
}) {
  return (
    <li
      id={domId}
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

        {/* Eight rows carrying the same five words are told apart by where
            they are, so the row says where it is. Two digits because the
            column then never changes width between 9 and 10. */}
        <span class="block-index">{String(position).padStart(2, '0')}</span>

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

        <div class="block-actions">
          <span
            class="block-grip"
            draggable
            role="button"
            tabIndex={0}
            aria-label="拖曳以調整順序"
            title="移動"
            onDragStart={(event) => {
              event.dataTransfer?.setData('text/plain', block.id)
              onDragStart()
            }}
            onDragEnd={onDragEnd}
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

          <IconButton label="刪除" tone="danger" size="sm" onClick={onDelete}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
            </svg>
          </IconButton>

          <Menu label="更多區塊操作">
            <MenuGroup label="插入" />
            <MenuItem onClick={() => onInsert('above')}>在上方插入區塊</MenuItem>
            <MenuItem onClick={() => onInsert('below')}>在下方插入區塊</MenuItem>
            <MenuGroup label="區塊" />
            <MenuItem onClick={onDuplicate}>複製</MenuItem>
            <MenuItem onClick={onCopy}>複製區塊</MenuItem>
            {/* Shown even with nothing to paste, and disabled instead of
                hidden: a gesture that only appears once you have already
                used the other half of it is a gesture nobody finds. */}
            <MenuItem
              disabled={!onPaste}
              title={onPaste ? undefined : '沒有複製過的區塊，或那一個是這個版本認不得的型別'}
              onClick={onPaste ?? (() => {})}
            >
              貼上區塊
            </MenuItem>
          </Menu>
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
