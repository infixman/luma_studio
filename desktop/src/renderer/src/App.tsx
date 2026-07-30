import { useEffect, useState } from 'preact/hooks'

import { About } from './About'
import { PairingScreen } from './PairingScreen'
import { UploadScreen } from './UploadScreen'
import type { SessionStatus } from '../../shared/session'
import { mayWork, type VersionState } from '../../shared/versionGate'

/**
 * Which screen the tool is on: pairing, or uploading.
 *
 * The status comes from the main process rather than being tracked here, because
 * that is where the token is. This component knows whether there is a session,
 * not what it is.
 */
export function App() {
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [version, setVersion] = useState<{ state: VersionState | null; message: string } | null>(null)

  useEffect(() => {
    void window.desktop.auth.status().then(setStatus)
  }, [])

  // Asked once there is a session, because the answer needs the token. The main
  // process refuses an upload from a stopped build as well — this is the part
  // that explains it rather than the part that enforces it.
  useEffect(() => {
    if (!status?.paired) return
    void window.desktop.versionState().then(setVersion)
  }, [status?.paired])

  if (status === null) {
    return (
      <main class="shell">
        <p class="muted">讀取中</p>
      </main>
    )
  }

  // `About` on both screens, not only after pairing. It carries the licence of a
  // GPL binary this tool ships, and somebody who cannot pair — wrong code, no
  // back office to hand — would never reach it otherwise.
  return (
    <>
      {version?.message ? (
        <p class={mayWork(version.state) ? 'muted' : 'alert'} role="status">
          {version.message}
        </p>
      ) : null}

      {status.paired && mayWork(version?.state ?? null) ? (
        <UploadScreen
          adminEmail={status.adminEmail ?? ''}
          onSignOut={() => {
            void window.desktop.auth.signOut().then(setStatus)
          }}
        />
      ) : status.paired ? (
        // Stopped by the server. The screen goes rather than being disabled:
        // a drop target that silently refuses a file is a tool somebody thinks
        // is broken.
        <main class="shell">
          <p class="muted">請安裝新版之後再繼續上傳。</p>
        </main>
      ) : (
        <PairingScreen status={status} onPaired={setStatus} />
      )}
      <About />
    </>
  )
}
