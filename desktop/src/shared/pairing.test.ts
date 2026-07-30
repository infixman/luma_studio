import { describe, expect, test } from 'vitest'

import { normalise, normaliseCode, normaliseEmail, problemWith } from './pairing'

describe('the code as it is actually typed', () => {
  test('the space the back office renders is stripped', () => {
    /** The page shows `418 302` on purpose — six digits in a row are hard to
     *  read off a screen — so that is what gets typed. Without this the tool
     *  refuses the code the page just displayed. */
    expect(normaliseCode('418 302')).toBe('418302')
  })

  test('so is whatever else a copy out of a chat window brings', () => {
    expect(normaliseCode(' 418-302 ')).toBe('418302')
    expect(normaliseCode('418.302')).toBe('418302')
    expect(normaliseCode('418_302')).toBe('418302')
    // A non-breaking space, which is what some clients paste.
    expect(normaliseCode('418 302')).toBe('418302')
  })

  test('an already clean code is left alone', () => {
    expect(normaliseCode('418302')).toBe('418302')
  })
})

describe('the email as the server holds it', () => {
  test('it is lowercased and trimmed', () => {
    /** The seed is derived from the address, so a capital letter derives a
     *  different seed and produces a correct code that never matches. */
    expect(normaliseEmail('  Owner@Example.COM ')).toBe('owner@example.com')
  })
})

describe('what can be submitted', () => {
  test('a normalised pair is accepted', () => {
    expect(problemWith({ email: 'owner@example.com', code: '418 302' })).toBeNull()
  })

  test('a missing email is named', () => {
    expect(problemWith({ email: '  ', code: '418302' })?.message).toContain('信箱')
  })

  test('something that is not an address is named', () => {
    expect(problemWith({ email: 'owner', code: '418302' })?.message).toContain('信箱')
  })

  test('a missing code is named', () => {
    expect(problemWith({ email: 'owner@example.com', code: '' })?.message).toContain('驗證碼')
  })

  test.each(['12345', '1234567', 'abcdef', '４１８３０２'])(
    'a code that is not six ASCII digits is refused locally: %s',
    (code) => {
      /** Checked here as well as at the server, because submitting it would
       *  spend an attempt against the lockout for something the tool could see
       *  was wrong. Full-width digits included: they are digits to a naive
       *  check and the server refuses them. */
      expect(problemWith({ email: 'owner@example.com', code })?.message).toContain('6 位數字')
    },
  )

  test('normalising is what gets sent, not what was typed', () => {
    expect(normalise({ email: ' Owner@Example.com ', code: '418 302' })).toEqual({
      email: 'owner@example.com',
      code: '418302',
    })
  })
})

test('it says which field the problem is in', () => {
  /** The interface marks the field rather than printing a sentence, so the
   *  field is part of the answer -- not something the caller re-derives by
   *  matching on the message text. */
  expect(problemWith({ email: '', code: '418302' })?.field).toBe('email')
  expect(problemWith({ email: 'owner', code: '418302' })?.field).toBe('email')
  expect(problemWith({ email: 'owner@example.com', code: '' })?.field).toBe('code')
  expect(problemWith({ email: 'owner@example.com', code: '41' })?.field).toBe('code')
})
