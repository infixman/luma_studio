import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

export type StatusKind = 'ok' | 'error' | 'plain'

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

  const showError = useCallback((error: unknown) => show(error instanceof Error ? error.message : '操作失敗', 'error'), [show])

  useEffect(() => () => clearTimeout(timer.current), [])

  return { message, show, showError }
}

export function StatusBar({ message }: { message: StatusMessage | null }) {
  return (
    <div id="status" class={message ? `visible ${message.kind}` : ''} aria-live="polite">
      {message?.text ?? ''}
    </div>
  )
}
