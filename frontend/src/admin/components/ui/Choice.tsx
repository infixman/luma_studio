import { useId } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

/**
 * Checkbox, radio and toggle.
 *
 * All three keep the real input and hide it, rather than drawing a div and
 * bolting the behaviour back on. The browser already does the tab order, the
 * space bar, the arrow keys within a radio group, the form association and
 * the announcement — reimplementing that is how a control ends up unusable
 * without a mouse. Only the box itself is drawn.
 */

interface CheckboxProps {
  label: ComponentChildren
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  disabled?: boolean
}

export function Checkbox({ label, checked, onChange, hint, disabled }: CheckboxProps) {
  const id = useId()
  return (
    <div class="ui-choice">
      <input
        id={id}
        type="checkbox"
        class="ui-choice-input"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
      />
      <label class="ui-choice-label" for={id}>
        <span class="ui-box" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="m5 12 4 4L19 6" />
          </svg>
        </span>
        <span class="ui-choice-text">
          {label}
          {hint && (
            <small id={`${id}-hint`} class="ui-choice-hint">
              {hint}
            </small>
          )}
        </span>
      </label>
    </div>
  )
}

interface RadioGroupProps<T extends string> {
  legend: string
  value: T | null
  options: { value: T; label: string; hint?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  /** Laid out across rather than down, for two or three short options. */
  inline?: boolean
}

export function RadioGroup<T extends string>({ legend, value, options, onChange, inline }: RadioGroupProps<T>) {
  const name = useId()
  return (
    <fieldset class={inline ? 'ui-radio-group is-inline' : 'ui-radio-group'}>
      <legend class="ui-label">{legend}</legend>
      {options.map((option) => {
        const id = `${name}-${option.value}`
        return (
          <div class="ui-choice" key={option.value}>
            <input
              id={id}
              type="radio"
              name={name}
              class="ui-choice-input"
              checked={option.value === value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <label class="ui-choice-label" for={id}>
              <span class="ui-dot" aria-hidden="true" />
              <span class="ui-choice-text">
                {option.label}
                {option.hint && <small class="ui-choice-hint">{option.hint}</small>}
              </span>
            </label>
          </div>
        )
      })}
    </fieldset>
  )
}

interface ToggleProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  disabled?: boolean
}

/**
 * For a setting that takes effect as soon as it is flipped. A checkbox is for
 * something that will be saved with the rest of a form; a switch says the
 * change has already happened, so the two are not interchangeable.
 */
export function Toggle({ label, checked, onChange, hint, disabled }: ToggleProps) {
  const id = useId()
  return (
    <div class="ui-toggle-row">
      <span class="ui-choice-text">
        <label class="ui-toggle-label" for={id}>
          {label}
        </label>
        {hint && <small class="ui-choice-hint">{hint}</small>}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        class="ui-choice-input ui-toggle-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
      />
      <label class="ui-toggle-track" for={id} aria-hidden="true">
        <span class="ui-toggle-knob" />
      </label>
    </div>
  )
}
