import { join } from 'node:path'

import { BrowserWindow, app, ipcMain, shell } from 'electron'

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

// One instance. Two copies transcoding into the same working directory would
// interleave their output, and the second one would look like a corrupt encode.
if (!app.requestSingleInstanceLock()) {
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
