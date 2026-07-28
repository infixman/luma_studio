import { useCallback, useRef } from 'preact/hooks'

/**
 * Ignores the answer to a question that has already been asked again.
 *
 * Searching debounces the *timer*, never a request already in flight. So
 * typing 貓 and then 咪 can land the fast 貓咪 answer first and the slow 貓
 * answer on top of it — the box reads 咪, the list shows 貓, and it stays
 * wrong until the next keystroke. Clearing the box mid-flight is worse: an
 * empty search over a filtered list.
 *
 * A counter rather than an AbortController: the request is cheap and already
 * on its way, and what actually matters is not sending the request but
 * refusing to paint a stale one. Errors are dropped the same way — an older
 * request failing says nothing about what is on screen now.
 */
export function useLatest() {
  const ticket = useRef(0)

  /** Wraps work so that only the most recent call may act on its result. */
  return useCallback(async (work: (isCurrent: () => boolean) => Promise<void>) => {
    const mine = ++ticket.current
    await work(() => mine === ticket.current)
  }, [])
}
