import { describe, expect, test } from 'vitest'

import { EXPIRY_MARGIN_SECONDS, isUsable, parseSession, secondsLeft } from './session'

const NOW = 1_785_292_800

function aSession(overrides: Record<string, unknown> = {}) {
  return {
    token: 'dv1.payload.signature',
    adminEmail: 'owner@example.com',
    scope: 'video',
    expiresAt: NOW + 12 * 60 * 60,
    ...overrides,
  }
}

describe('whether the tool should offer to upload', () => {
  test('a fresh token is usable', () => {
    expect(isUsable(aSession(), NOW)).toBe(true)
  })

  test('an expired one is not', () => {
    expect(isUsable(aSession({ expiresAt: NOW - 1 }), NOW)).toBe(false)
  })

  test('nor is one about to expire', () => {
    /** An upload started with four minutes left fails after the transcode
     *  rather than before it, which is the expensive way round. */
    expect(isUsable(aSession({ expiresAt: NOW + EXPIRY_MARGIN_SECONDS - 1 }), NOW)).toBe(false)
  })

  test('one just past the margin still is', () => {
    expect(isUsable(aSession({ expiresAt: NOW + EXPIRY_MARGIN_SECONDS + 1 }), NOW)).toBe(true)
  })

  test('no session is not usable', () => {
    expect(isUsable(null, NOW)).toBe(false)
  })

  test('a session with no token is not usable either', () => {
    expect(isUsable(aSession({ token: '' }) as never, NOW)).toBe(false)
  })
})

describe('how long is left', () => {
  test('it is the real remaining time, not the margin-adjusted one', () => {
    /** Shown to a person, who should see what the server said rather than the
     *  tool's safety buffer. */
    expect(secondsLeft(aSession({ expiresAt: NOW + 90 }), NOW)).toBe(90)
  })

  test('it never goes negative', () => {
    expect(secondsLeft(aSession({ expiresAt: NOW - 500 }), NOW)).toBe(0)
  })
})

describe('reading one back off disk', () => {
  test('a well-formed record survives the trip', () => {
    expect(parseSession(aSession())).toEqual(aSession())
  })

  test.each([
    ['nothing', null],
    ['a string', 'dv1.x.y'],
    ['no token', aSession({ token: undefined })],
    ['an empty token', aSession({ token: '' })],
    ['no email', aSession({ adminEmail: undefined })],
    ['no scope', aSession({ scope: undefined })],
    ['an expiry that is not a number', aSession({ expiresAt: '1785292800' })],
    ['an expiry that is not finite', aSession({ expiresAt: Number.POSITIVE_INFINITY })],
  ])('%s reads as no session rather than throwing', (_name, raw) => {
    /** This comes off disk, where a half-written file, an older format and a
     *  manual edit are all possible. The recovery is the same every time: pair
     *  again. A crash on launch is not that. */
    expect(parseSession(raw)).toBeNull()
  })
})
