import { useEffect, useState } from 'preact/hooks'

import { About } from './About'
import { PairingScreen } from './PairingScreen'
import { UploadScreen } from './UploadScreen'
import type { SessionStatus } from '../../shared/session'

/**
 * Which screen the tool is on: pairing, or uploading.
 *
 * The status comes from the main process rather than being tracked here, because
 * that is where the token is. This component knows whether there is a session,
 * not what it is.
 */
export function App() {
  const [status, setStatus] = useState<SessionStatus | null>(null)

  useEffect(() => {
    void window.desktop.auth.status().then(setStatus)
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
    <>
      <UploadScreen
        adminEmail={status.adminEmail ?? ''}
        onSignOut={() => {
          void window.desktop.auth.signOut().then(setStatus)
        }}
      />
      <About />
    </>
  )
}
