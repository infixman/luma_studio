import { describe, expect, test, vi } from 'vitest'

import { withRetry, type RetryPolicy } from './retry'

const noSleep = (): Promise<void> => Promise.resolve()

function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { attempts: 4, delayMs: 10, worthRetrying: () => true, sleep: noSleep, ...overrides }
}

describe('trying again', () => {
  test('work that succeeds first time runs once', async () => {
    const work = vi.fn(async () => 'done')

    await expect(withRetry(work, policy())).resolves.toBe('done')
    expect(work).toHaveBeenCalledTimes(1)
  })

  test('a transient failure is ridden out', async () => {
    /** Several hundred requests over a domestic connection means a few of them
     *  failing is ordinary. Without this, a two-hour transfer is decided by its
     *  unluckiest second. */
    let calls = 0
    const work = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('reset by peer')
      return 'done'
    })

    await expect(withRetry(work, policy())).resolves.toBe('done')
    expect(work).toHaveBeenCalledTimes(3)
  })

  test('it gives up after the last attempt and reports the real failure', async () => {
    /** A loop that keeps going turns one permanently broken object into a
     *  program that never finishes and never says why. */
    const work = vi.fn(async () => {
      throw new Error('gone for good')
    })

    await expect(withRetry(work, policy({ attempts: 3 }))).rejects.toThrow('gone for good')
    expect(work).toHaveBeenCalledTimes(3)
  })

  test('a failure not worth retrying is raised at once', async () => {
    /** 401 above all: retrying it walks the admin into the pairing lockout. */
    const work = vi.fn(async () => {
      throw new Error('unauthorised')
    })

    await expect(withRetry(work, policy({ worthRetrying: () => false }))).rejects.toThrow(
      'unauthorised',
    )
    expect(work).toHaveBeenCalledTimes(1)
  })

  test('the attempt number is passed in, so work can report which try it is', async () => {
    const seen: number[] = []
    const work = vi.fn(async (attempt: number) => {
      seen.push(attempt)
      if (attempt < 3) throw new Error('again')
      return attempt
    })

    await withRetry(work, policy())

    expect(seen).toEqual([1, 2, 3])
  })

  test('the wait grows with the attempt but does not explode', async () => {
    /** Linear, because what is being ridden out is a dropped connection rather
     *  than a service we are overwhelming — there is one uploader. Exponential
     *  backoff spends minutes finding out the network came back seconds ago. */
    const waits: number[] = []
    const work = vi.fn(async () => {
      throw new Error('again')
    })

    await expect(
      withRetry(
        work,
        policy({
          attempts: 4,
          delayMs: 100,
          sleep: async (ms) => {
            waits.push(ms)
          },
        }),
      ),
    ).rejects.toThrow()

    expect(waits).toEqual([100, 200, 300])
  })

  test('one attempt means no waiting at all', async () => {
    const sleep = vi.fn(noSleep)
    const work = vi.fn(async () => {
      throw new Error('no')
    })

    await expect(withRetry(work, policy({ attempts: 1, sleep }))).rejects.toThrow()
    expect(sleep).not.toHaveBeenCalled()
  })
})
