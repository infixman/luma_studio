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
/**
 * Nothing here yet, said the same way everywhere.
 *
 * `compact` is for the panels and sidebars where the full 48px of breathing
 * room would push the rest of the panel off screen. It is a size, not a
 * second kind of empty state — the pages that wrote their own
 * `<p class="muted">還沒有…</p>` did it because this one was too tall for
 * where they needed it, and two idioms is how the next one gets invented.
 */
export function EmptyState({
  title,
  body,
  action,
  compact = false,
}: {
  title: string
  body?: string
  action?: ComponentChildren
  compact?: boolean
}) {
  return (
    <div class={compact ? 'ui-empty is-compact' : 'ui-empty'}>
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

/**
 * The list stopped at its limit and this says so.
 *
 * Three pages wrote their own, and all three ended with "用搜尋縮小範圍" —
 * advice that reads as nonsense to somebody who has already typed a search and
 * is being cut short inside its results. `narrowed` is whether anything is
 * filtering already, and it changes the sentence rather than the number.
 */
export function Truncated({
  count,
  unit,
  narrowed = false,
  children,
}: {
  count: number
  /** 筆 / 張 / 位 — the measure word this list counts in. */
  unit: string
  narrowed?: boolean
  /** Anything else worth saying, when being cut short has a consequence. */
  children?: ComponentChildren
}) {
  return (
    <p class="muted warn">
      {narrowed
        ? `符合的太多，只顯示最新的 ${count} ${unit}。再縮小範圍才看得到其餘的。`
        : `只顯示最新的 ${count} ${unit}。用搜尋或篩選縮小範圍。`}
      {children}
    </p>
  )
}
