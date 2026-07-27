import { describe, expect, it } from 'vitest'

import { escapeHtml, oneLine, pageTitle } from './index'

describe('escapeHtml', () => {
  it('neutralises the characters that would break out of an attribute', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
    expect(escapeHtml('"><script>alert(1)</script>')).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes the ampersand first so entities are not double-broken', () => {
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('苒光繪誌｜台中・桃園')).toBe('苒光繪誌｜台中・桃園')
  })
})

describe('oneLine', () => {
  it('collapses the line breaks a preview card cannot show', () => {
    expect(oneLine('台中開課\n兒童美術\n\n成人肌理畫')).toBe('台中開課 兒童美術 成人肌理畫')
  })

  it('trims the ends', () => {
    expect(oneLine('  hello  ')).toBe('hello')
  })

  it('truncates with an ellipsis past the limit', () => {
    const result = oneLine('a'.repeat(200))
    expect(result).toHaveLength(160)
    expect(result.endsWith('…')).toBe(true)
  })

  it('leaves text at exactly the limit alone', () => {
    expect(oneLine('a'.repeat(160))).toBe('a'.repeat(160))
  })
})

describe('pageTitle', () => {
  it('appends the studio name', () => {
    expect(pageTitle('喬喬老師')).toBe('喬喬老師 | 苒光繪誌')
  })

  it('does not repeat a studio name the display name already carries', () => {
    expect(pageTitle('苒光繪誌｜喬喬老師')).toBe('苒光繪誌｜喬喬老師')
  })

  it('falls back to the studio name when nothing is set', () => {
    expect(pageTitle('')).toBe('苒光繪誌')
  })
})
