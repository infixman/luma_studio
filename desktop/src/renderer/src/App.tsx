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

  // Stopped by the server. The whole screen is the update, because there is
  // nothing else to do here: the drop target goes rather than being disabled,
  // since a target that silently refuses a file is a tool somebody thinks is
  // broken.
  if (status.paired && !mayWork(version?.state ?? null)) {
    return (
      <>
        <main class="shell">
          <h1>需要更新才能繼續上傳</h1>
          {/* Said once. This screen used to say it three times — the server's
              sentence, the download line, and a third telling somebody to
              install a new version underneath the two that already had. */}
          {version?.message ? <p class="muted">{version.message}</p> : null}
          <UpdateProgress update={update} />
        </main>
        <About />
      </>
    )
  }

  // `About` on both screens, not only after pairing. It carries the licence of
  // a GPL binary this tool ships, and somebody who cannot pair — wrong code, no
  // back office to hand — would never reach it otherwise.
  return (
    <>
      {/* Still working, and there is a newer build. A strip rather than the
          screen: it is worth knowing and not worth stopping for. Held to the
          same width as everything under it — outside the shell it started at
          the window's edge, lining up with nothing. */}
      {version?.state?.verdict?.updateAvailable ? (
        <div class="shell update-strip" role="status">
          {version?.message ? <span class="muted">{version.message}</span> : null}
          <UpdateProgress update={update} />
        </div>
      ) : null}

      {status.paired ? (
        <UploadScreen
          adminEmail={status.adminEmail ?? ''}
          onSignOut={() => {
            void window.desktop.auth.signOut().then(setStatus)
          }}
        />
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
    // The button says what happens; a sentence in front of it saying the same
    // thing in longer words is one of the three this screen used to carry.
    return (
      <div class="update-line">
        <button type="button" onClick={() => void window.desktop.installUpdate()}>
          重新啟動並安裝{update.version ? ` ${update.version}` : ''}
        </button>
      </div>
    )
  }

  if (update?.error) {
    // The download is the tool's own doing and invisible; a failure nobody
    // reports leaves somebody waiting for something that already gave up. The
    // way out belongs with the failure rather than on a line of its own.
    return (
      <p class="alert">下載新版失敗：{update.error}。可以到後台的「桌面工具」頁面直接下載安裝檔。</p>
    )
  }

  return <p class="muted update-line">下載新版中…</p>
}
