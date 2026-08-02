import { createContext } from 'preact'
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

/**
 * The `⋯` menu, and the popover the column chooser sits in.
 *
 * A row with five buttons on it makes every row five buttons wide, and the
 * one that matters is never the one your eye lands on. Folding them behind a
 * single trigger costs a click and buys a list you can read.
 *
 * The keyboard is the part that is easy to skip and impossible to do without:
 * ↑/↓ walk the items, Home/End jump, Esc closes and hands focus back to the
 * trigger. Same rules as the Select next door, so the two feel like one thing.
 *
 * The popup is positioned against the viewport rather than against the trigger.
 * As an absolutely-positioned child it was clipped by the first ancestor that
 * scrolls — which on every list page is the table's own `overflow-x`, so the
 * menu on the last column came out with its right half cut off. Fixed
 * positioning is outside that box; the cost is that it does not travel with a
 * scroll, so scrolling closes it.
 */

const Close = createContext<() => void>(() => {})

interface MenuProps {
  /** Announces the trigger, which is usually just three dots. */
  label: string
  /** The trigger's face. Defaults to `⋯`. */
  trigger?: ComponentChildren
  /** `icon` is the square `⋯`; `button` is a normal labelled button. */
  variant?: 'icon' | 'button'
  children: ComponentChildren
}

const ITEM_SELECTOR = '.ui-menu-item:not([disabled])'

export function Menu({ label, trigger, variant = 'icon', children }: MenuProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  // Where the popup sits, in viewport coordinates. Measured when it opens:
  // the trigger has not moved by then, and reading layout during render would
  // be a measurement of the frame before.
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)

  const close = useCallback((focusTrigger = true) => {
    setOpen(false)
    if (focusTrigger) button.current?.focus()
  }, [])

  function show() {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setAt({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    setOpen(true)
  }

  // A popup pinned to the viewport does not follow the thing it belongs to, so
  // anything that moves that thing closes it. Better than a menu hovering
  // beside an unrelated row.
  useEffect(() => {
    if (!open) return
    const away = () => setOpen(false)
    window.addEventListener('scroll', away, true)
    window.addEventListener('resize', away)
    return () => {
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('resize', away)
    }
  }, [open])

  // Clicking anywhere else closes it. Pointerdown rather than click, so a
  // drag that starts outside and ends inside cannot leave it open.
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  // Opening lands on the first item, so ↓ is not needed before Enter.
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus()
  }, [open])

  function step(delta: number) {
    const items = [...(list.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = at < 0 ? 0 : (at + delta + items.length) % items.length
    items[next]?.focus()
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close()
        break
      case 'ArrowDown':
        event.preventDefault()
        step(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        step(-1)
        break
      case 'Home':
      case 'End': {
        event.preventDefault()
        const items = [...(list.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])]
        ;(event.key === 'Home' ? items[0] : items[items.length - 1])?.focus()
        break
      }
      case 'Tab':
        // Tab leaves the menu entirely; the browser is already moving focus,
        // so taking it back to the trigger would fight it.
        close(false)
        break
    }
  }

  return (
    <div class="ui-menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        class={[
          variant === 'icon' ? 'ui-icon-button tone-ghost size-sm' : 'ui-button tone-neutral size-sm',
          open ? 'is-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={variant === 'icon' ? label : undefined}
        title={variant === 'icon' ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            show()
          }
        }}
      >
        {trigger ?? <Dots />}
      </button>

      {open && (
        <div
          id={id}
          ref={list}
          class={'ui-menu'}
          role="menu"
          aria-label={label}
          style={at ? { top: `${at.top}px`, right: `${at.right}px` } : undefined}
          onKeyDown={onKeyDown}
        >
          <Close.Provider value={close}>{children}</Close.Provider>
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  children: ComponentChildren
  onClick: () => void
  /** `danger` for the one that cannot be undone. */
  tone?: 'neutral' | 'danger'
  disabled?: boolean
  title?: string
}

export function MenuItem({ children, onClick, tone = 'neutral', disabled, title }: MenuItemProps) {
  const close = useContext(Close)
  return (
    <button
      type="button"
      role="menuitem"
      class={`ui-menu-item tone-${tone}`}
      disabled={disabled}
      title={title}
      onClick={() => {
        onClick()
        // Every item here picks something and is done. A toggle that wanted
        // the menu to stay up would be a different control — the column
        // chooser is one, and it is not built on this.
        close()
      }}
    >
      {children}
    </button>
  )
}

/** A labelled break between groups of items — "看" above "改". */
export function MenuGroup({ label }: { label: string }) {
  return (
    <p class="ui-menu-group" role="presentation">
      {label}
    </p>
  )
}

/**
 * A checkable item, for menus that are a list of settings rather than a list
 * of actions. `role="menuitemcheckbox"` is what tells a screen reader that
 * this one reports a state instead of doing something.
 */
export function MenuCheckItem({
  children,
  checked,
  onChange,
  disabled,
}: {
  children: ComponentChildren
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      class="ui-menu-item is-check"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="ui-menu-tick" aria-hidden="true">
        {checked && (
          <svg viewBox="0 0 24 24">
            <path d="m5 12 4 4L19 6" />
          </svg>
        )}
      </span>
      {children}
    </button>
  )
}

function Dots() {
  return (
    <svg class="ui-dots" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  )
}
