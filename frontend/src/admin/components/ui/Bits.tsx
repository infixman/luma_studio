import type { ComponentChildren } from 'preact'

/** The small pieces: panels, badges, empty states, and a table wrapper. */

export function Panel({
  title,
  actions,
  children,
  class: extra,
}: {
  title?: string
  /** Buttons on the panel's own header row, beside its title. */
  actions?: ComponentChildren
  children: ComponentChildren
  class?: string
}) {
  return (
    <section class={['ui-panel', extra ?? ''].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <header class="ui-panel-head">
          {title && <h2 class="ui-panel-title">{title}</h2>}
          {actions && <div class="ui-panel-actions">{actions}</div>}
        </header>
      )}
      <div class="ui-panel-body">{children}</div>
    </section>
  )
}

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ComponentChildren }) {
  return <span class={`ui-badge tone-${tone}`}>{children}</span>
}

/**
 * Nothing to show, and what to do about it. An empty list with no explanation
 * reads as a page that failed to load.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: ComponentChildren
}) {
  return (
    <div class="ui-empty">
      <p class="ui-empty-title">{title}</p>
      {body && <p class="ui-empty-body">{body}</p>}
      {action}
    </div>
  )
}

/**
 * Tables scroll inside this rather than widening the page. A back office has
 * columns that cannot be dropped — an id, a total — and the alternative is a
 * horizontal scrollbar on the whole window.
 */
export function TableWrap({ children }: { children: ComponentChildren }) {
  return (
    <div class="ui-table-wrap">
      <table class="ui-table">{children}</table>
    </div>
  )
}

export function Spinner({ label = '載入中' }: { label?: string }) {
  return (
    <p class="ui-loading" role="status">
      <span class="ui-spinner" aria-hidden="true" />
      {label}
    </p>
  )
}
