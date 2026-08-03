import type { ComponentChildren } from 'preact'
import { useId } from 'preact/hooks'

/** The small pieces: panels, badges, empty states, and a table wrapper. */

export function Panel({
  title,
  actions,
  children,
  class: extra,
  collapsed = false,
  onCollapsedChange,
}: {
  title?: string
  /** Buttons on the panel's own header row, beside its title. */
  actions?: ComponentChildren
  children: ComponentChildren
  class?: string
  /** Controlled disclosure for long editor panels. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const bodyId = useId()
  const collapsible = onCollapsedChange !== undefined
  return (
    <section class={['ui-panel', collapsed ? 'is-collapsed' : '', extra ?? ''].filter(Boolean).join(' ')}>
      {(title || actions || collapsible) && (
        <header class="ui-panel-head">
          {title && <h2 class="ui-panel-title">{title}</h2>}
          {(actions || collapsible) && (
            <div class="ui-panel-actions">
              {actions}
              {collapsible && (
                <button
                  type="button"
                  class="ui-panel-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={bodyId}
                  aria-label={`${collapsed ? '展開' : '收合'}${title ?? '區塊'}`}
                  title={`${collapsed ? '展開' : '收合'}${title ?? '區塊'}`}
                  onClick={() => onCollapsedChange(!collapsed)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m7 10 5 5 5-5" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </header>
      )}
      <div id={bodyId} class="ui-panel-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  )
}

/**
 * A section inside a panel, and the buttons that act on it.
 *
 * The same rule the panel header follows, one level down: what this part is
 * on the left, what you can do to it on the right. Pages that needed this
 * were writing a bare `<h3>` and then hanging an "add one" button off the
 * bottom of the list underneath — which is why "where is the add button"
 * had a different answer on every page.
 */
export function Section({
  title,
  actions,
  children,
}: {
  title: string
  actions?: ComponentChildren
  children: ComponentChildren
}) {
  return (
    <section class="ui-section">
      <header class="ui-section-head">
        <h3 class="ui-subhead">{title}</h3>
        {actions && <div class="ui-section-actions">{actions}</div>}
      </header>
      {children}
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
