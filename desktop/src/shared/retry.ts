/**
 * Trying again, a bounded number of times, for the failures worth retrying.
 *
 * An upload is several hundred requests over a domestic connection, so a few of
 * them failing is ordinary rather than exceptional — without retries a
 * two-hour transfer is decided by its unluckiest second.
 *
 * The bound matters as much as the retrying. A loop that keeps going turns one
 * permanently broken object into a program that never finishes and never says
 * why, and on an authentication failure it walks the admin into the pairing
 * lockout.
 */

export interface RetryPolicy {
  attempts: number
  /** Base delay; each attempt waits this multiplied by the attempt number. */
  delayMs: number
  /** Whether a given failure is worth another attempt. */
  worthRetrying: (error: unknown) => boolean
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_ATTEMPTS = 4

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Linear rather than exponential backoff.
 *
 * The failures being ridden out here are a dropped connection and a moment of
 * congestion, not a service being overwhelmed by us — there is one uploader.
 * Exponential backoff would spend minutes waiting to discover the network came
 * back seconds ago.
 */
export async function withRetry<T>(
  work: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  const sleep = policy.sleep ?? defaultSleep
  let last: unknown

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await work(attempt)
    } catch (error) {
      last = error
      if (!policy.worthRetrying(error)) throw error
      if (attempt === policy.attempts) break
      await sleep(policy.delayMs * attempt)
    }
  }
  throw last
}
