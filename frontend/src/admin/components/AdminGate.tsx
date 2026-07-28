import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'

import { ApiError, loginUrl, probeSession } from '../../shared/api'
import '../styles/admin.css'
import '../styles/admin-gate.css'

/**
 * Nothing about the back office is shown until we know who is asking.
 *
 * Rendering the pages first and letting each one's 401 bounce the visitor to
 * Google meant a stranger saw the whole thing on the way past: the tab names,
 * the card headings, the shape of every form. None of that is a secret worth
 * much on its own, and together it is a description of the business written
 * for someone who was never meant to read it.
 *
 * So the shell is the sign-in page until proven otherwise, and the pages only
 * mount once there is a session. They keep their own 401 handling for the
 * session that expires while somebody is working.
 */
type State = { kind: 'checking' } | { kind: 'anonymous' } | { kind: 'offline'; message: string } | { kind: 'in' }

export function AdminGate({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<State>({ kind: 'checking' })

  useEffect(() => {
    probeSession<{ email: string }>('/api/session')
      .then((session) => setState(session ? { kind: 'in' } : { kind: 'anonymous' }))
      .catch((error) =>
        // A network failure is not the same as being turned away, and saying
        // "sign in" to someone whose connection is down sends them in circles.
        setState({ kind: 'offline', message: error instanceof ApiError ? error.message : '無法連線到伺服器' }),
      )
  }, [])

  if (state.kind === 'in') return <>{children}</>

  return (
    <main class="gate">
      <img class="brand-logo" src="/assets/luma-studio-logo.png" alt="Luma Studio 苒光繪誌" />
      {state.kind === 'checking' && <p class="gate-note">確認登入狀態…</p>}
      {state.kind === 'anonymous' && (
        <>
          <p class="gate-note">這裡是管理介面，需要授權才能使用。</p>
          <a class="gate-action" href={loginUrl(location.href)}>
            以 Google 登入
          </a>
        </>
      )}
      {state.kind === 'offline' && (
        <>
          <p class="gate-note error">{state.message}</p>
          <button type="button" class="gate-action" onClick={() => location.reload()}>
            重試
          </button>
        </>
      )}
    </main>
  )
}
