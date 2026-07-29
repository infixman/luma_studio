/**
 * Asking for permission to play, and knowing when not to ask again.
 *
 * Retrying a refusal that is about who you are does not change the answer; it
 * just means the same 403 arrives repeatedly while the page looks broken.
 */

import { describe, expect, test } from 'vitest'

import { RENEW_BEFORE_SECONDS, renewDelay, worthRetrying } from './playback'

describe('when a refusal is worth another try', () => {
  test('a video still encoding will become ready on its own', () => {
    expect(worthRetrying('not_ready')).toBe(true)
  })

  test.each(['not_entitled', 'expired', 'revoked', 'no_video', 'not_found', 'unknown'] as const)(
    '%s is a statement about this member, so asking again is asking louder',
    (reason) => {
      expect(worthRetrying(reason)).toBe(false)
    },
  )
})

describe('renewing before the session lapses', () => {
  test('a fresh session is renewed with time to spare', () => {
    // Renewing exactly at expiry would put the request and the first refused
    // segment in the same instant.
    expect(renewDelay(1000, 0)).toBe(1000 - RENEW_BEFORE_SECONDS)
  })

  test('a session already inside the renewal window is renewed at once', () => {
    expect(renewDelay(1000, 950)).toBe(0)
  })

  test('a session that has already lapsed does not schedule a negative wait', () => {
    expect(renewDelay(1000, 5000)).toBe(0)
  })
})
