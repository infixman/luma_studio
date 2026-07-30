import { useRef } from 'preact/hooks'

import { CODE_LENGTH, normaliseCode } from '../../shared/pairing'

/**
 * Six digits, one slot each.
 *
 * A single narrow box beside a wide email field looks like a mistake, and a
 * single wide box invites the thought that something longer than six characters
 * belongs in it. Slots say how many digits there are without a sentence about it.
 *
 * The behaviour that makes them worth the code rather than annoying:
 *
 * A paste lands in whatever slot was focused and is spread across all of them,
 * separators stripped — the back office renders `418 302`, so that is what gets
 * pasted, and per-slot `maxLength` would otherwise keep the `4` and drop the rest.
 *
 * Backspace in an empty slot moves back and clears the one before it, because
 * pressing it twice to delete one character is the thing that makes segmented
 * inputs unpleasant.
 *
 * The value handed upwards is always the joined string, so nothing above here
 * knows this is six elements.
 */
export function CodeInput({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange: (code: string) => void
}) {
  const slots = useRef<(HTMLInputElement | null)[]>([])

  const digits = normaliseCode(value).slice(0, CODE_LENGTH).split('')
  const at = (index: number): string => digits[index] ?? ''

  function focusSlot(index: number): void {
    const target = slots.current[Math.max(0, Math.min(CODE_LENGTH - 1, index))]
    target?.focus()
    target?.select()
  }

  function replace(index: number, incoming: string): void {
    // Separators stripped by `normaliseCode`, then digits only. A slot for one
    // digit should not hold a letter — the shared helper leaves them because the
    // server is what decides a code is malformed, and here there is nothing to
    // decide.
    const cleaned = normaliseCode(incoming).replace(/[^0-9]/g, '')
    if (!cleaned) return

    const next = [...digits]
    // More than one character means a paste. Spreading it from the focused slot
    // rather than always from the first is what makes pasting into the middle
    // behave the way it looks like it will.
    for (let offset = 0; offset < cleaned.length && index + offset < CODE_LENGTH; offset++) {
      next[index + offset] = cleaned[offset]!
    }
    onChange(next.join(''))
    focusSlot(index + cleaned.length)
  }

  function onKeyDown(index: number, event: KeyboardEvent): void {
    if (event.key === 'Backspace') {
      event.preventDefault()
      const next = [...digits]
      if (next[index]) {
        next[index] = ''
        onChange(next.join('').replace(/\s/g, ''))
        return
      }
      // Empty already, so take the one before it and go there. Two presses to
      // delete one character is what makes these unpleasant.
      if (index > 0) {
        next[index - 1] = ''
        onChange(next.join(''))
        focusSlot(index - 1)
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusSlot(index - 1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusSlot(index + 1)
    }
  }

  return (
    <div class="code-slots" role="group" aria-label="驗證碼">
      {Array.from({ length: CODE_LENGTH }, (_unused, index) => (
        <input
          key={index}
          ref={(element) => {
            slots.current[index] = element
          }}
          // Not `type="number"`: it strips leading zeros and offers a spinner for
          // something that is not a quantity.
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellcheck={false}
          disabled={disabled}
          class="code-slot"
          aria-label={`第 ${index + 1} 位`}
          // Deliberately not 1. A paste has to arrive intact to be spread; with
          // `maxLength={1}` the browser keeps the first character and drops five.
          maxLength={CODE_LENGTH}
          value={at(index)}
          onFocus={(event) => (event.currentTarget as HTMLInputElement).select()}
          onInput={(event) => {
            const field = event.currentTarget as HTMLInputElement
            const typed = field.value
            // Put the model's value back immediately; `replace` decides what the
            // slot should actually show.
            field.value = at(index)
            replace(index, typed)
          }}
          onKeyDown={(event) => onKeyDown(index, event as KeyboardEvent)}
        />
      ))}
    </div>
  )
}
