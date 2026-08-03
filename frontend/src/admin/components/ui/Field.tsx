import { useId } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

/**
 * A labelled control, with room underneath for the two things a form has to
 * be able to say: what this field is for, and what is wrong with it.
 *
 * The label is tied to the control by id rather than by wrapping it. Wrapping
 * works until a field holds two controls — a number and its unit, a value and
 * the button that resets it — and then the label points at whichever one the
 * browser guessed.
 *
 * An error replaces the hint rather than joining it. Two lines under a field,
 * one of them red, is a puzzle about which one still applies.
 */

interface FieldProps {
  label: string
  /** Rendered under the control when there is no error. */
  hint?: string
  error?: string | null
  required?: boolean
  /**
   * Hide the label from sight but keep it for a screen reader.
   *
   * For the places where the control already says what it is — a page-size
   * dropdown reading 每頁 50 does not need 每頁 written above it as well —
   * and where a stacked label would make one row twice as tall as the rest.
   */
  hiddenLabel?: boolean
  /** Given the id to put on the control, and the id of its description. */
  children: (ids: { id: string; describedBy: string | undefined }) => ComponentChildren
}

export function Field({ label, hint, error, required, hiddenLabel, children }: FieldProps) {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint

  return (
    <div class={error ? 'ui-field has-error' : 'ui-field'}>
      <label class={hiddenLabel ? 'ui-label is-hidden' : 'ui-label'} for={id}>
        {label}
        {required && (
          <span class="ui-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({ id, describedBy: note ? noteId : undefined })}
      {note && (
        <p class={error ? 'ui-note is-error' : 'ui-note'} id={noteId} role={error ? 'alert' : undefined}>
          {note}
        </p>
      )}
    </div>
  )
}

type InputProps = Omit<JSX.IntrinsicElements['input'], 'size'>

interface TextFieldProps extends InputProps {
  label: string
  hint?: string
  error?: string | null
  /** Keep the label for screen readers only — see Field. */
  hiddenLabel?: boolean
  /** Sits inside the field, at the end — a unit, or a button that acts on the value. */
  trailing?: ComponentChildren
}

export function TextField({
  label,
  hint,
  error,
  required,
  hiddenLabel,
  trailing,
  class: extra,
  ...rest
}: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required={Boolean(required)} hiddenLabel={hiddenLabel}>
      {({ id, describedBy }) => (
        <div class="ui-input-wrap">
          <input
            id={id}
            class={['ui-input', extra ?? ''].filter(Boolean).join(' ')}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            required={required}
            {...rest}
          />
          {trailing && <div class="ui-input-trailing">{trailing}</div>}
        </div>
      )}
    </Field>
  )
}

type TextAreaAttributes = JSX.IntrinsicElements['textarea']

interface TextAreaProps extends TextAreaAttributes {
  label: string
  hint?: string
  error?: string | null
}

export function TextArea({ label, hint, error, required, rows = 4, class: extra, ...rest }: TextAreaProps) {
  return (
    <Field label={label} hint={hint} error={error} required={Boolean(required)}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          rows={rows}
          class={['ui-input ui-textarea', extra ?? ''].filter(Boolean).join(' ')}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          required={required}
          {...rest}
        />
      )}
    </Field>
  )
}
