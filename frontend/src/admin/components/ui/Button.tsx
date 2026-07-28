import type { ComponentChildren, JSX } from 'preact'

/* Preact keeps the per-element attribute interfaces unexported inside its JSX
   namespace, so the intrinsic element is the way to borrow them. */
type ButtonAttributes = JSX.IntrinsicElements['button']

/**
 * Every button in the back office, in four flavours.
 *
 * `tone` says what the button means, not what colour it is: the day the
 * palette changes, "danger" still means danger. `busy` is separate from
 * `disabled` because the two read differently to somebody waiting — one says
 * "not yet", the other says "working on it".
 */

export type ButtonTone = 'primary' | 'neutral' | 'danger' | 'ghost'

interface ButtonProps extends Omit<ButtonAttributes, 'size'> {
  tone?: ButtonTone
  size?: 'sm' | 'md'
  busy?: boolean
  /** Sits before the label, at the size of the text around it. */
  icon?: ComponentChildren
}

export function Button({
  tone = 'neutral',
  size = 'md',
  busy = false,
  icon,
  children,
  class: extra,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      class={['ui-button', `tone-${tone}`, `size-${size}`, busy ? 'busy' : '', extra ?? ''].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span class="ui-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends Omit<ButtonAttributes, 'size'> {
  /** Required: the button has no text, so this is the only thing announcing it. */
  label: string
  tone?: ButtonTone
  size?: 'sm' | 'md'
  children: ComponentChildren
}

export function IconButton({ label, tone = 'ghost', size = 'md', children, class: extra, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      class={['ui-icon-button', `tone-${tone}`, `size-${size}`, extra ?? ''].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  )
}

/** A row of buttons with the spacing already decided. */
export function ButtonRow({ children, align = 'start' }: { children: ComponentChildren; align?: 'start' | 'end' }) {
  return <div class={`ui-button-row align-${align}`}>{children}</div>
}
