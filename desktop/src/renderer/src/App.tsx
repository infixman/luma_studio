import { useEffect, useState } from 'preact/hooks'

import { PairingScreen } from './PairingScreen'
import type { SessionStatus } from '../../shared/session'

/**
 * Which screen the tool is on.
 *
 * Two states so far: not paired, and paired with nothing to do yet. The upload
 * screen is the next step.
 *
 * The status comes from the main process rather than being tracked here, because
 * that is where the token is. This component knows whether there is a session,
 * not what it is.
 */
export function App() {
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.desktop.auth.status().then(setStatus)
    void window.desktop.version().then(setVersion)
  }, [])

  if (status === null) {
    return (
      <main class="shell">
        <p class="muted">讀取中</p>
      </main>
    )
  }

  if (!status.paired) {
    return <PairingScreen status={status} onPaired={setStatus} />
  }

  return (
    <main class="shell">
      <h1>苒光繪誌 影片上傳工具</h1>
      <p class="muted">
        已連結 {status.adminEmail}。這個工具沒有 R2 金鑰 —— 它拿到的是一組只能做影片操作的
        短效憑證。
      </p>
      <p class="muted">上傳畫面還沒做。版本 {version || '讀取中'}</p>
      <button
        type="button"
        onClick={() => {
          void window.desktop.auth.signOut().then(setStatus)
        }}
      >
        取消連結
      </button>
    </main>
  )
}
