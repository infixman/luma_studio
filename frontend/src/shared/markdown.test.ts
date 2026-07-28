import { describe, expect, it } from 'vitest'

import { escapeHtml, renderMarkdown } from './markdown'

/**
 * The safety property is the ordering: escape everything, then apply the
 * rules. These tests exist mostly to keep someone from "improving" that by
 * moving the escape later or adding a raw-HTML passthrough.
 */

describe('what cannot get through', () => {
  it('turns a script tag into text', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('turns an img with a handler into text', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  it('refuses a javascript: link but keeps the words', () => {
    const html = renderMarkdown('[點我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a ')
    // Losing the words would be a worse surprise than losing the link.
    expect(html).toContain('點我')
  })

  it('refuses a data: link', () => {
    expect(renderMarkdown('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('<a ')
  })

  it('cannot break out of an href attribute', () => {
    const html = renderMarkdown('[x](https://a" onmouseover="alert(1))')
    expect(html).not.toContain('onmouseover="alert')
  })

  it('escapes quotes and ampersands in ordinary text', () => {
    expect(escapeHtml(`a & b "c" 'd'`)).toBe('a &amp; b &quot;c&quot; &#39;d&#39;')
  })
})

describe('what a policy page needs', () => {
  it('renders headings below the page title', () => {
    // The page owns the h1; a block starts at h2 so the outline stays sane.
    expect(renderMarkdown('# 退換貨')).toBe('<h2>退換貨</h2>')
    expect(renderMarkdown('## 條件')).toBe('<h3>條件</h3>')
  })

  it('joins wrapped lines into one paragraph', () => {
    expect(renderMarkdown('一行\n接著一行')).toBe('<p>一行 接著一行</p>')
  })

  it('starts a new paragraph on a blank line', () => {
    expect(renderMarkdown('第一段\n\n第二段')).toBe('<p>第一段</p><p>第二段</p>')
  })

  it('renders both kinds of list', () => {
    expect(renderMarkdown('- 甲\n- 乙')).toBe('<ul><li>甲</li><li>乙</li></ul>')
    expect(renderMarkdown('1. 甲\n2. 乙')).toBe('<ol><li>甲</li><li>乙</li></ol>')
  })

  it('does not run two kinds of list together', () => {
    const html = renderMarkdown('- 甲\n1. 乙')
    expect(html).toBe('<ul><li>甲</li></ul><ol><li>乙</li></ol>')
  })

  it('renders bold, italic and links', () => {
    expect(renderMarkdown('**粗**')).toBe('<p><strong>粗</strong></p>')
    expect(renderMarkdown('*斜*')).toBe('<p><em>斜</em></p>')
    expect(renderMarkdown('[站](https://luma-studio.tw)')).toContain('<a href="https://luma-studio.tw" rel="noopener">站</a>')
  })

  it('allows a link to somewhere on this site', () => {
    expect(renderMarkdown('[商城](/shop)')).toContain('href="/shop"')
  })

  it('allows mailto', () => {
    expect(renderMarkdown('[寫信](mailto:hi@example.com)')).toContain('href="mailto:hi@example.com"')
  })
})

describe('what it does with the unfamiliar', () => {
  it('leaves an unsupported construct as visible text', () => {
    // A table nobody rendered is a thing the owner can see and work around;
    // silently dropping it is not.
    const html = renderMarkdown('| a | b |')
    expect(html).toBe('<p>| a | b |</p>')
  })

  it('renders nothing for nothing', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('   \n\n  ')).toBe('')
  })
})
