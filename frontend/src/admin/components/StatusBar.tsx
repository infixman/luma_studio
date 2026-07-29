import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { ApiError } from '../../shared/api'

export type StatusKind = 'ok' | 'warn' | 'error' | 'plain'

interface StatusMessage {
  text: string
  kind: StatusKind
}

const VISIBLE_MS = 4200

export function useStatus() {
  const [message, setMessage] = useState<StatusMessage | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const show = useCallback((text: string, kind: StatusKind = 'plain') => {
    clearTimeout(timer.current)
    setMessage({ text, kind })
    timer.current = setTimeout(() => setMessage(null), VISIBLE_MS)
  }, [])

  /**
   * Says what went wrong — except when nothing did.
   *
   * A 401 means the api client has already sent the visitor to Google, and
   * the page is about to be replaced. Announcing it would flash an error at
   * somebody who is being signed in, which is not a failure they can act on.
   *
   * This lived at every call site as `if (!(error instanceof ApiError &&
   * error.status === 401))`, twelve times, and every new page had to remember
   * it. No caller has a reason to know about that rule.
   */
  const showError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) return
      show(error instanceof Error ? error.message : '操作失敗', 'error')
    },
    [show],
  )

  useEffect(() => () => clearTimeout(timer.current), [])

  /**
   * The wrapper six pages had copied verbatim: refuse while something else is
   * running, report either way, and say whether it worked.
   *
   * `work` may return its own sentence, for actions whose outcome is not known
   * until the server answers. It is shown in the warning tone: something that
   * had to correct the caller's optimistic `done` did not go entirely to plan.
   */
  const [busy, setBusy] = useState(false)
  const run = useCallback(
    async (work: () => Promise<string | void>, done: string): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      try {
        const said = await work()
        show(said || done, said ? 'warn' : 'ok')
        return true
      } catch (error) {
        showError(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [busy, show, showError],
  )

  return { message, show, showError, busy, run }
}

export function StatusBar({ message }: { message: StatusMessage | null }) {
  return (
    <div id="status" class={message ? `visible ${message.kind}` : ''} aria-live="polite">
      {message?.kind === 'ok' && <SuccessCheck />}
      {message?.text ?? ''}
    </div>
  )
}

function SuccessCheck() {
  return (
    <svg class="status-check" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}
