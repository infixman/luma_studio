import { useEffect, useState } from 'preact/hooks'

import { About } from './About'
import { PairingScreen } from './PairingScreen'
import { UploadScreen } from './UploadScreen'
import type { SessionStatus } from '../../shared/session'
import type { UpdateState } from '../../shared/updateState'
import { mayWork, type VersionState } from '../../shared/versionGate'

/** How often to re-read the download while it is still going. The main
 *  process holds the state and does not push, so this is the only way to
 *  see a download finish without the operator restarting the tool. */
const UPDATE_POLL_MS = 2000

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
  const [update, setUpdate] = useState<UpdateState | null>(null)

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

  /**
   * What the updater has managed so far.
   *
   * The download starts on its own once the policy says there is a newer
   * build, and then nothing was ever read back: `updateState` and
   * `installUpdate` existed on the bridge and no screen called either. So a
   * stopped build told somebody to install a new version while holding the
   * new version it had already downloaded, with no way to apply it — the
   * updater refuses to install on quit on purpose, because that would end a
   * two-hour upload.
   *
   * Polled because the main process holds this and does not push. It stops
   * once there is nothing left to wait for.
   */
  useEffect(() => {
    if (!status?.paired) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const read = async () => {
      const next = await window.desktop.updateState()
      if (!live) return
      setUpdate(next)
      if (!next.downloaded && !next.error) timer = setTimeout(() => void read(), UPDATE_POLL_MS)
    }
    void read()

    return () => {
      live = false
      clearTimeout(timer)
    }
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

      {/* Once, above whichever screen is showing. A build that still works
          needs this as much as a stopped one: without it the download that
          already finished has nowhere to be applied either, and the banner
          saying "there is a new version" is advice with no way to take it. */}
      {version?.state?.verdict?.updateAvailable ? <UpdateProgress update={update} /> : null}

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

/**
 * Where the new build has got to, and the one button that applies it.
 *
 * Nothing here starts the download — the updater does that by itself as soon
 * as the server says there is a newer build. What was missing is all of this:
 * saying it is happening, saying when it failed, and offering the restart.
 * Installing stays a decision because the alternative is a tool that quits
 * during a two-hour upload.
 */
function UpdateProgress({ update }: { update: UpdateState | null }) {
  if (update?.downloaded) {
    return (
      <>
        <p class="muted">
          新版{update.version ? ` ${update.version}` : ''}已經下載好了，重新啟動就會換過去。
        </p>
        <button type="button" onClick={() => void window.desktop.installUpdate()}>
          重新啟動並安裝
        </button>
      </>
    )
  }

  if (update?.error) {
    // The download is the tool's own doing and invisible; a failure nobody
    // reports leaves somebody waiting for something that already gave up.
    return (
      <>
        <p class="alert">下載新版失敗：{update.error}</p>
        <p class="muted">可以到後台的「桌面工具」頁面直接下載安裝檔。</p>
      </>
    )
  }

  return <p class="muted">正在下載新版，下載完成後就可以重新啟動安裝。</p>
}
