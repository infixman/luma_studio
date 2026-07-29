import { describe, expect, it } from 'vitest'

import { htmlToPlainText, textToHtml } from './rich-text'

describe('textToHtml', () => {
  it('leaves empty text empty', () => {
    expect(textToHtml('')).toBe('')
  })

  it('turns paragraphs and line breaks into escaped HTML', () => {
    expect(textToHtml('one\ntwo\n\n<three>')).toBe('<p>one<br>two</p><p>&lt;three&gt;</p>')
  })

  it('does not wrap existing HTML again', () => {
    expect(textToHtml('<p>already HTML</p>')).toBe('<p>already HTML</p>')
  })
})

describe('htmlToPlainText', () => {
  it('makes a readable summary from editor markup', () => {
    expect(htmlToPlainText('<p>Hello<br>world &amp; friends</p>')).toBe('Hello world & friends')
  })
})
