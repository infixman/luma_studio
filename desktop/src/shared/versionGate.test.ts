import { describe, expect, test } from 'vitest'

import { mayWork, versionMessage, type VersionState } from './versionGate'

function state(overrides: Partial<VersionState> = {}): VersionState {
  return {
    verdict: { allowed: true, mustUpdate: false, updateAvailable: false, reason: 'ok' },
    latest: '1.2.0',
    notes: '',
    ...overrides,
  }
}

describe('whether this build may work', () => {
  test('a current one may', () => {
    expect(mayWork(state())).toBe(true)
  })

  test('one the server stopped may not', () => {
    expect(
      mayWork(state({ verdict: { allowed: false, mustUpdate: true, updateAvailable: true, reason: 'tooOld' } })),
    ).toBe(false)
  })

  test('not having been able to ask does not stop anything', () => {
    /** Every upload goes through the same API, so a tool that cannot ask cannot
     *  upload either. Stopping here turns bad wifi into "your tool is out of
     *  date", which is a different and wrong thing to say. */
    expect(mayWork(state({ verdict: null }))).toBe(true)
    expect(mayWork(null)).toBe(true)
  })
})

describe('what it says', () => {
  test('a stopped version says why and what to install', () => {
    const said = versionMessage(
      state({ verdict: { allowed: false, mustUpdate: true, updateAvailable: true, reason: 'blocked' } }),
    )

    expect(said).toContain('停用')
    expect(said).toContain('1.2.0')
  })

  test('too old and blocked do not say the same thing', () => {
    /** One is "this build aged out", the other is "this build is broken". They
     *  lead to the same action but not to the same question to ask. */
    const tooOld = versionMessage(
      state({ verdict: { allowed: false, mustUpdate: true, updateAvailable: true, reason: 'tooOld' } }),
    )
    const blocked = versionMessage(
      state({ verdict: { allowed: false, mustUpdate: true, updateAvailable: true, reason: 'blocked' } }),
    )

    expect(tooOld).not.toBe(blocked)
  })

  test('a reason nobody anticipated still says something useful', () => {
    const said = versionMessage(
      state({ verdict: { allowed: false, mustUpdate: true, updateAvailable: true, reason: 'moon' } }),
    )

    expect(said).not.toBe('')
  })

  test('an update available is mentioned without stopping the work', () => {
    /** "There is a new one" and "you cannot work" are two levers, and blurring
     *  them teaches people to ignore both. */
    const said = versionMessage(
      state({ verdict: { allowed: true, mustUpdate: false, updateAvailable: true, reason: 'ok' } }),
    )

    expect(said).toContain('1.2.0')
    expect(mayWork(state({ verdict: { allowed: true, mustUpdate: false, updateAvailable: true, reason: 'ok' } }))).toBe(
      true,
    )
  })

  test('a current version says nothing at all', () => {
    expect(versionMessage(state())).toBe('')
  })

  test('an unanswered check says nothing rather than guessing', () => {
    expect(versionMessage(state({ verdict: null }))).toBe('')
  })
})
