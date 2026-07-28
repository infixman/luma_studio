/**
 * A small Markdown subset, rendered to HTML that is safe by construction.
 *
 * The whole input is escaped first and the rules are applied afterwards, so
 * a `<script>` in the source can only ever come out as the text
 * `&lt;script&gt;`. Safety comes from that ordering, not from a blocklist
 * somebody has to keep current — there is no path by which an unexpected tag
 * reaches the output, because the only tags in the output are ones this file
 * writes.
 *
 * The subset is what a terms-of-service or refund-policy page needs:
 * headings, paragraphs, bold, italic, links, and both kinds of list. It is
 * deliberately not CommonMark. Anything unrecognised stays as literal text,
 * which is the failure people can see and fix.
 *
 * Used by the storefront to render a text block and by the back office to
 * preview one. The same input cannot produce two different pages because
 * there is only one implementation.
 */

/** Schemes a link may use. `javascript:` is the reason this list exists. */
const SAFE_SCHEMES = ['http://', 'https://', 'mailto:', '/']

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeHref(href: string): string | null {
  const trimmed = href.trim()
  // Already escaped by the time this runs, so a quote cannot break out of the
  // attribute; this check is about where the link goes, not how it is written.
  return SAFE_SCHEMES.some((scheme) => trimmed.toLowerCase().startsWith(scheme)) ? trimmed : null
}

/** Bold, italic and links, applied to already-escaped text. */
function inline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      const safe = safeHref(href)
      // A rejected link keeps its text rather than vanishing: losing the
      // words is a worse surprise than losing the link.
      return safe ? `<a href="${safe}" rel="noopener">${label}</a>` : label
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
}

interface ListState {
  ordered: boolean
  items: string[]
}

function renderList(list: ListState): string {
  const tag = list.ordered ? 'ol' : 'ul'
  return `<${tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split(/\r?\n/)
  const out: string[] = []
  let list: ListState | null = null
  let paragraph: string[] = []

  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const closeList = () => {
    if (list) {
      out.push(renderList(list))
      list = null
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (!trimmed) {
      closeParagraph()
      closeList()
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (heading) {
      closeParagraph()
      closeList()
      const level = heading[1]!.length + 1 // # is an h2; the page owns the h1.
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      closeParagraph()
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) closeList()
      if (!list) list = { ordered, items: [] }
      list.items.push(inline((bullet ?? numbered)![1]!))
      continue
    }

    closeList()
    paragraph.push(trimmed)
  }

  closeParagraph()
  closeList()
  return out.join('')
}
