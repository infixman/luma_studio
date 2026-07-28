import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'

import { Field } from './Field'

/**
 * A dropdown the design can actually reach.
 *
 * A native <select> renders its list with the operating system, which is why
 * it looks like Windows on Windows and like nothing else in this back office.
 * Replacing it is only worth doing if the keyboard comes with it, so all of
 * it is here: ↑/↓ to move, Home/End to jump, letters to type ahead, Enter or
 * Space to take, Esc to leave it as it was. A custom dropdown without those
 * is a downgrade wearing better paint.
 *
 * Two rules that are easy to get wrong and are what make it feel native:
 * moving through the list does not change the value — only Enter, Space or a
 * click does — and Esc restores whatever was selected when it opened.
 */

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  disabled?: boolean
}

interface SelectProps<T extends string> {
  label: string
  value: T | null
  options: SelectOption<T>[]
  onChange: (value: T) => void
  hint?: string
  error?: string | null
  required?: boolean
  disabled?: boolean
  /** Shown when nothing is selected. */
  placeholder?: string
}

/** How long a run of keystrokes counts as one word being typed. */
const TYPEAHEAD_MS = 700

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  required,
  disabled,
  placeholder = '請選擇',
}: SelectProps<T>) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const typed = useRef({ text: '', at: 0 })

  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value])
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const close = useCallback((focusTrigger = true) => {
    setOpen(false)
    if (focusTrigger) trigger.current?.focus()
  }, [])

  function openList() {
    if (disabled) return
    // Opening lands on what is already selected, so ↓ moves from there rather
    // than from the top of a list somebody has already made a choice in.
    setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled(options))
    setOpen(true)
  }

  function take(index: number) {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    close()
  }

  // Clicking anywhere else closes it. Pointerdown rather than click: a click
  // that starts outside and ends inside should not leave it open.
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  // Keep the active option in view when the keyboard is doing the moving.
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function step(from: number, delta: number): number {
    const count = options.length
    for (let move = 1; move <= count; move += 1) {
      const next = from + delta * move
      if (next < 0 || next >= count) break
      if (!options[next]?.disabled) return next
    }
    return from
  }

  function jumpToTyped(character: string, from: number): number {
    const now = Date.now()
    typed.current =
      now - typed.current.at > TYPEAHEAD_MS
        ? { text: character, at: now }
        : { text: typed.current.text + character, at: now }
    const needle = typed.current.text.toLowerCase()

    // Start after the current one, so pressing the same letter twice walks
    // through everything beginning with it instead of sticking on the first.
    for (let move = 1; move <= options.length; move += 1) {
      const index = (from + move) % options.length
      const option = options[index]
      if (option && !option.disabled && option.label.toLowerCase().startsWith(needle)) return index
    }
    return from
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled) return

    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openList()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((current) => step(current, 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((current) => step(current, -1))
        break
      case 'Home':
        event.preventDefault()
        setActive(firstEnabled(options))
        break
      case 'End':
        event.preventDefault()
        setActive(lastEnabled(options))
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        take(active)
        break
      case 'Escape':
        event.preventDefault()
        // The Escape that closes this list must not also close the dialog the
        // list is sitting in. One key, one thing.
        event.stopPropagation()
        // Leave it as it was: nothing was committed while moving around.
        close()
        break
      case 'Tab':
        // Tab leaves the field entirely, so it closes without stealing focus
        // back to the trigger the browser is already moving away from.
        close(false)
        break
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          setActive((current) => jumpToTyped(event.key, current))
        }
    }
  }

  return (
    <Field label={label} hint={hint} error={error} required={Boolean(required)}>
      {({ id, describedBy }) => (
        <div class="ui-select" ref={wrap}>
          <button
            id={id}
            ref={trigger}
            type="button"
            class={['ui-input ui-select-trigger', open ? 'is-open' : '', selected ? '' : 'is-empty']
              .filter(Boolean)
              .join(' ')}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            disabled={disabled}
            onClick={() => (open ? close() : openList())}
            onKeyDown={onKeyDown}
          >
            <span class="ui-select-value">{selected?.label ?? placeholder}</span>
            <Chevron />
          </button>

          {open && (
            <ul
              id={listId}
              ref={list}
              class="ui-listbox"
              role="listbox"
              aria-label={label}
              aria-activedescendant={`${listId}-${active}`}
            >
              {options.map((option, index) => (
                <li
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  data-active={index === active}
                  class={[
                    'ui-option',
                    index === active ? 'is-active' : '',
                    option.value === value ? 'is-selected' : '',
                    option.disabled ? 'is-disabled' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onPointerEnter={() => !option.disabled && setActive(index)}
                  onClick={() => take(index)}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Tick />}
                </li>
              ))}
              {options.length === 0 && <li class="ui-option is-disabled">沒有可選的項目</li>}
            </ul>
          )}
        </div>
      )}
    </Field>
  )
}

function firstEnabled(options: SelectOption<string>[]): number {
  const index = options.findIndex((option) => !option.disabled)
  return index < 0 ? 0 : index
}

function lastEnabled(options: SelectOption<string>[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index
  }
  return 0
}

function Chevron() {
  return (
    <svg class="ui-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function Tick() {
  return (
    <svg class="ui-tick" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}
