import { autoUpdater } from 'electron-updater'

/**
 * Fetching a new build, when the server says there is one.
 *
 * The feed URL comes from the policy the server answered with rather than from
 * the packaged configuration. Both exist — electron-builder needs one at build
 * time to write `latest.yml` — but a baked-in URL is the production one, and a
 * build installed from staging would then check the live feed and offer itself
 * the wrong installer. The server that answered "you may work" is the server
 * whose releases this install belongs to.
 *
 * Nothing installs itself. The download happens quietly; replacing the program
 * happens when somebody says so, because the alternative is a tool that restarts
 * in the middle of a two-hour upload.
 */

import type { UpdateState } from '../shared/updateState'

let configured = false

const state: UpdateState = { checking: false, downloaded: false, version: '', error: '' }

export function updateState(): UpdateState {
  return { ...state }
}

/**
 * Point the updater at this deployment's feed and look once.
 *
 * Called after the version policy answers, so it is never pointed at a feed the
 * server did not name. A failure is recorded rather than raised: an update check
 * that cannot reach the internet is not a reason to stop an upload that is about
 * to go to the same internet — and if that is really down, the upload will say
 * so in a way that means something.
 */
export async function checkForUpdate(feedUrl: string): Promise<UpdateState> {
  if (!feedUrl) return updateState()

  if (!configured) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    autoUpdater.autoDownload = true
    // Replacing the program is a decision, not a side effect: quitting to
    // install in the middle of a two-hour upload would lose the upload.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('update-downloaded', (info) => {
      state.downloaded = true
      state.version = String(info?.version ?? '')
      state.checking = false
    })
    autoUpdater.on('error', (error: unknown) => {
      state.error = error instanceof Error ? error.message.slice(0, 200) : '更新失敗'
      state.checking = false
    })
    configured = true
  }

  state.checking = true
  state.error = ''
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    state.error = error instanceof Error ? error.message.slice(0, 200) : '更新檢查失敗'
  } finally {
    state.checking = false
  }
  return updateState()
}

/**
 * Restart into the new build.
 *
 * Only reached from a button, and only once `update-downloaded` has fired —
 * quitting without a downloaded installer just closes the tool.
 */
export function installNow(): boolean {
  if (!state.downloaded) return false
  autoUpdater.quitAndInstall()
  return true
}
