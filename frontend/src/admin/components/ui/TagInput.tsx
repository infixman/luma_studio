import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'

import { Field } from './Field'

/**
 * Tags: pick one that exists, or type one that does not.
 *
 * A plain <select> cannot do the second half and a plain text box cannot do
 * the first, which is why this is neither. The suggestions are the tags
 * already in use, so the owner keeps landing on the same word instead of
 * growing "首頁", "首頁圖" and "首頁用" for one idea.
 *
 * The keyboard follows Select.tsx, and for the same reason: ↑/↓ move through
 * the list without choosing anything, Enter takes what is highlighted, Esc
 * leaves the list without adding. The one rule that differs is Enter with
 * nothing highlighted — here it creates the tag as typed, because refusing to
 * would make the "type a new one" half unreachable from the keyboard.
 *
 * Backspace on an empty box removes the last chip. Every chip also has its own
 * remove button: the keyboard shortcut is a shortcut, not the only way out.
 */

interface TagInputProps {
  label: string
  value: string[]
  /** Every tag already in use, most used first. Only ever suggestions. */
  options: string[]
  onChange: (tags: string[]) => void
  hint?: string
  error?: string | null
  disabled?: boolean
  max?: number
  maxLength?: number
  placeholder?: string
}

/** How many suggestions are worth showing. Past this nobody reads them. */
const MAX_SUGGESTIONS = 8

/**
 * The same shape the server stores tags in, so what is offered, what is shown
 * and what is saved are one string rather than three that nearly match.
 */
export function normaliseTag(raw: string, maxLength: number): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Z]/g, (character) => character.toLowerCase())
    .slice(0, maxLength)
}

export function TagInput({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  disabled,
  max = 10,
  maxLength = 30,
  placeholder = '輸入後按 Enter 新增',
}: TagInputProps) {
  const listId = useId()
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const full = value.length >= max
  const typed = normaliseTag(draft, maxLength)

  const suggestions = useMemo(() => {
    const taken = new Set(value)
    return options
      .filter((tag) => !taken.has(tag) && (!typed || tag.includes(typed)))
      .slice(0, MAX_SUGGESTIONS)
  }, [options, value, typed])

  // A list that stays open over an empty result is a box that looks broken.
  useEffect(() => {
    if (suggestions.length === 0) setOpen(false)
    setActive(-1)
  }, [suggestions.length, typed])

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  function add(tag: string) {
    const clean = normaliseTag(tag, maxLength)
    // Silently ignoring a duplicate rather than complaining: it is already
    // there, which is what the owner wanted either way.
    if (!clean || full || value.includes(clean)) {
      setDraft('')
      return
    }
    onChange([...value, clean])
    setDraft('')
    setOpen(false)
  }

  function removeAt(index: number) {
    onChange(value.filter((_, position) => position !== index))
    input.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (suggestions.length === 0) return
        setOpen(true)
        setActive((current) => Math.min(current + 1, suggestions.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        if (suggestions.length === 0) return
        setActive((current) => Math.max(current - 1, -1))
        break
      case 'Enter':
        // Not a submit: this control lives inside forms that save on a button.
        event.preventDefault()
        add(open && active >= 0 ? (suggestions[active] ?? draft) : draft)
        break
      case ',':
      case 'Tab':
        // A comma is what people type between tags, so it means the same as
        // Enter. Tab only commits when there is something half-typed to lose.
        if (!typed) return
        event.preventDefault()
        add(draft)
        break
      case 'Escape':
        // Nothing was added while moving around, so this only closes the list.
        if (!open) return
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        break
      case 'Backspace':
        if (draft === '' && value.length > 0) {
          event.preventDefault()
          removeAt(value.length - 1)
        }
        break
    }
  }

  const note = full ? `最多 ${max} 個標籤` : hint

  return (
    <Field label={label} hint={note} error={error}>
      {({ id, describedBy }) => (
        <div class="ui-tags" ref={box}>
          <div class={['ui-tag-box', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
            {value.map((tag, index) => (
              <span key={tag} class="ui-tag">
                {tag}
                <button
                  type="button"
                  class="ui-tag-remove"
                  aria-label={`移除標籤 ${tag}`}
                  disabled={disabled}
                  onClick={() => removeAt(index)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              id={id}
              ref={input}
              class="ui-tag-input"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
              aria-describedby={describedBy}
              autocomplete="off"
              maxLength={maxLength}
              placeholder={full ? '' : placeholder}
              value={draft}
              disabled={disabled || full}
              onInput={(event) => {
                setDraft((event.target as HTMLInputElement).value)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
            />
          </div>

          {open && suggestions.length > 0 && (
            <ul id={listId} class="ui-listbox" role="listbox" aria-label={label}>
              {suggestions.map((tag, index) => (
                <li
                  key={tag}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  class={['ui-option', index === active ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onPointerEnter={() => setActive(index)}
                  // Pointerdown, not click: the input must not lose focus
                  // first, or the list closes before the choice lands.
                  onPointerDown={(event) => {
                    event.preventDefault()
                    add(tag)
                  }}
                >
                  <span>{tag}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  )
}
