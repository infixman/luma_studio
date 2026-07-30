import { join } from 'node:path'

import { BrowserWindow, app, ipcMain, safeStorage, shell } from 'electron'

import { AdminApiError } from '../shared/adminApi'
import type { PairingInput } from '../shared/pairing'
import type { UploadRequest } from '../shared/upload'
import { ingest } from './ingest'
import { licencePaths } from './ffmpeg'
import { Cancelled, cancel } from './transcoder'
import * as session from './session'
import * as uploader from './uploader'

/**
 * The main process: the only part of this tool with an operating system.
 *
 * Everything privileged lives here — the pairing token, the file system, and
 * later FFmpeg. The window that draws the interface gets none of it. That split
 * is not ceremony: this tool loads no remote content today, but a renderer with
 * Node access is one careless `<img>` away from being a shell, and the cost of
 * keeping it out is a preload file.
 */

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_040,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // The starburst comes in S7 with the rest of the packaging.
    webPreferences: {
      // `.cjs` because the sandbox refuses an ES module preload. See the
      // preload build in electron.vite.config.ts.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // The three that matter, spelled out rather than left to defaults, so a
      // future Electron changing a default cannot quietly open one.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Shown when it has something to draw. A window that appears empty and then
  // fills in reads as a slow program even when it is not.
  window.once('ready-to-show', () => window.show())

  // A link in the interface should open in the browser, not replace the tool
  // with a web page and no way back.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // And nothing navigates this window anywhere. The interface is a local file;
  // any navigation away from it is either a mistake or something that would
  // leave the tool showing a web page with no way back to itself.
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return window
}

/**
 * `--self-check`: report what the app can see, then exit.
 *
 * A packaged app is not the same program as `electron-vite dev`. Its files live
 * inside an asar archive, `import.meta.dirname` resolves somewhere else, and
 * `app.getPath('userData')` finally means what it will mean on somebody's
 * machine. Those are the paths every later feature builds on — ffmpeg's
 * location, the resume ledger, the stored token — so being able to ask a
 * packaged build about them is worth one flag.
 *
 * It is also the answer to "it will not start" from somebody who cannot be
 * looked over the shoulder of: run it with this and send the file.
 */
async function selfCheck(): Promise<void> {
  const { existsSync, writeFileSync } = await import('node:fs')

  const preload = join(import.meta.dirname, '../preload/index.cjs')
  const renderer = join(import.meta.dirname, '../renderer/index.html')
  const report = {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    preload: { path: preload, exists: existsSync(preload) },
    renderer: { path: renderer, exists: existsSync(renderer) },
    canEncryptStorage: safeStorage.isEncryptionAvailable(),
  }

  const out = join(app.getPath('userData'), 'self-check.json')
  writeFileSync(out, JSON.stringify(report, null, 2))
  process.stdout.write(`${out}\n`)
  // Non-zero when something it needs is absent, so a script does not have to
  // parse the file to know.
  app.exit(report.preload.exists && report.renderer.exists ? 0 : 1)
}

// One instance. Two copies transcoding into the same working directory would
// interleave their output, and the second one would look like a corrupt encode.
if (process.argv.includes('--self-check')) {
  void app.whenReady().then(selfCheck)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(() => {
    // Registered before the window exists, so a renderer that asks immediately
    // is answered rather than left waiting on a handler that arrives later.
    //
    // `app.getVersion()` rather than the version in package.json, because this
    // is the value electron-updater compares against a release feed and the
    // version policy in S7 has to agree with it. Unpackaged it reports
    // Electron's own version, which looks wrong in development and is right in
    // the only build anybody installs.
    ipcMain.handle('app:version', () => app.getVersion())

    // The token lives in this process and is never sent to the renderer, so
    // these hand back facts about the session rather than the session.
    session.restore()
    ipcMain.handle('auth:status', () => session.status())
    ipcMain.handle('auth:signOut', () => session.signOut())
    ipcMain.handle('auth:pair', async (_event, input: PairingInput) => {
      try {
        return { ok: true as const, status: await session.pair(input) }
      } catch (error) {
        // Turned into a value rather than thrown across IPC. An exception
        // arriving in the renderer becomes "Error invoking remote method",
        // which is the wrong sentence to show somebody typing a code.
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : '配對失敗',
          httpStatus: error instanceof AdminApiError ? error.status : null,
        }
      }
    })

    ipcMain.handle('upload:scan', (_event, folder: string) => uploader.scan(folder))
    ipcMain.handle('upload:cancel', () => cancel())

    // FFmpeg is GPL, and this tool distributes a copy of it. The licence and
    // the corresponding source ship alongside it, and this is how somebody
    // finds them — an obligation, not a credit.
    ipcMain.handle('app:licences', () => licencePaths())

    ipcMain.handle('upload:start', async (event, request: UploadRequest) => {
      try {
        // Progress goes to the window that asked, by event rather than by
        // return value: an upload is minutes long and a single resolved promise
        // would leave the interface with nothing to show for it.
        const result = await ingest(request, session.requireToken().base, (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('upload:progress', progress)
        })
        return { ok: true as const, result }
      } catch (error) {
        return {
          ok: false as const,
          // A cancellation is not a failure to explain, so it gets its own
          // sentence rather than ffmpeg's exit code.
          message:
            error instanceof Cancelled
              ? '已取消'
              : error instanceof Error
                ? error.message
                : '上傳失敗',
          httpStatus: error instanceof AdminApiError ? error.status : null,
        }
      }
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Windows and Linux only. On macOS an app with no windows is normal, but
    // there is no macOS build — see the phase 4 task list.
    if (process.platform !== 'darwin') app.quit()
  })
}
