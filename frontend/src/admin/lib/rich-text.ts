import { escapeHtml } from '../../shared/markdown'

/** Turn plain paragraphs into editor HTML without touching existing markup. */
export function textToHtml(text: string): string {
  if (!text || /<\/?(?:a|abbr|b|blockquote|br|code|div|em|h[1-6]|hr|i|img|li|ol|p|pre|span|strong|ul)\b[^>]*>/i.test(text)) return text
  return text
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** A compact, readable preview of HTML or plaintext block content. */
export function htmlToPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
