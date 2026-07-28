import { Button } from './Button'
import { Select } from './Select'
import type { PageInfo } from '../../../shared/types'

/**
 * Which page you are on, and how to get to another one.
 *
 * Three lists used to answer with "the newest 200" and a note saying there
 * were more. That note was the whole problem: it named a number, offered no
 * way to reach the rest, and told you to search for the thing you were trying
 * to find. A pager says how many there are and lets you go there.
 *
 * The numbers are windowed rather than listed. Seventy page buttons is not
 * navigation, and the four that matter are first, last, and the two either
 * side of where you are.
 */

const SIZES = [20, 50, 100]

/** What a list asks for when nobody has said otherwise. Mirrors paging.py. */
export const DEFAULT_PER_PAGE = 50

/** First, last, and a short run around the current page — with gaps marked. */
export function pageNumbers(current: number, pages: number, span = 2): (number | 'gap')[] {
  const wanted = new Set<number>([1, pages])
  for (let page = current - span; page <= current + span; page += 1) {
    if (page >= 1 && page <= pages) wanted.add(page)
  }
  const sorted = [...wanted].sort((left, right) => left - right)

  const out: (number | 'gap')[] = []
  let previous = 0
  for (const page of sorted) {
    // A gap of exactly one is not worth an ellipsis — the number it hides is
    // narrower than the ellipsis hiding it.
    if (previous && page - previous === 2) out.push(previous + 1)
    else if (previous && page - previous > 2) out.push('gap')
    out.push(page)
    previous = page
  }
  return out
}

export function Pagination({
  info,
  unit,
  onPage,
  onPerPage,
  disabled = false,
}: {
  info: PageInfo | null
  /** 筆 / 張 / 位 — the measure word this list counts in. */
  unit: string
  onPage: (page: number) => void
  /** Omitted when the page size is not the reader's to choose. */
  onPerPage?: (perPage: number) => void
  disabled?: boolean
}) {
  // Nothing to page through, and nothing to say about it.
  if (!info || info.total === 0) return null

  const { page, pages, perPage, total } = info
  const first = (page - 1) * perPage + 1
  const last = first + info.count - 1

  return (
    <nav class="ui-pager" aria-label="分頁">
      <p class="ui-pager-count">
        {/* The range, not just the page number: "第 3 頁" says nothing about
            how far in you are. */}
        第 {first}–{last} {unit}，共 {total} {unit}
      </p>

      {pages > 1 && (
        <div class="ui-pager-pages">
          <Button tone="ghost" size="sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>
            上一頁
          </Button>
          {pageNumbers(page, pages).map((entry, index) =>
            entry === 'gap' ? (
              <span key={`gap-${index}`} class="ui-pager-gap" aria-hidden="true">
                …
              </span>
            ) : (
              <Button
                key={entry}
                tone={entry === page ? 'primary' : 'ghost'}
                size="sm"
                disabled={disabled}
                // The current page is still a button, so it keeps its place in
                // the tab order — but it says which one it is.
                aria-current={entry === page ? 'page' : undefined}
                onClick={() => onPage(entry)}
              >
                {entry}
              </Button>
            ),
          )}
          <Button tone="ghost" size="sm" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>
            下一頁
          </Button>
        </div>
      )}

      {onPerPage && (
        <Select
          label="每頁顯示幾筆"
          hiddenLabel
          value={String(perPage)}
          options={SIZES.map((size) => ({ value: String(size), label: `每頁 ${size}` }))}
          onChange={(value) => onPerPage(Number(value))}
        />
      )}
    </nav>
  )
}
