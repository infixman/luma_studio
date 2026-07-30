/**
 * Does the built app actually work?
 *
 * `electron-vite build` succeeding proves the three bundles compile. It proves
 * nothing about the part most likely to be wrong: whether the preload script is
 * found at the path the main process guesses, whether `contextBridge` exposed
 * anything, and whether the renderer loads from disk rather than from a dev
 * server. Each of those fails as an empty window and says nothing.
 *
 * So this runs the real main bundle under Electron, waits for the window, and
 * asks the page itself to call across the bridge.
 *
 *   npm run smoke
 *
 * No top-level `await` in here, and that is not style. Electron's `ready` event
 * fires while the entry module is still evaluating, so a top-level await on
 * `whenReady()` deadlocks: the promise cannot resolve until evaluation finishes
 * and evaluation cannot finish until the promise resolves. It hangs with no
 * output at all, which is a memorable half hour.
 */

import { BrowserWindow, app } from 'electron'

const TIMEOUT_MS = 20_000

app.commandLine.appendSwitch('disable-gpu')

function fail(reason) {
  console.error(`smoke: ${reason}`)
  app.exit(1)
}

const timer = setTimeout(() => fail('the window never became ready'), TIMEOUT_MS)

function windowAppears() {
  return new Promise((resolve) => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) return resolve(existing)
    app.once('browser-window-created', (_event, created) => resolve(created))
  })
}

function loaded(window) {
  return new Promise((resolve, reject) => {
    if (!window.webContents.isLoading()) return resolve()
    window.webContents.once('did-finish-load', resolve)
    window.webContents.once('did-fail-load', (_event, code, description) =>
      reject(new Error(`${description} (${code})`)),
    )
  })
}

/** The interface draws after two IPC round trips, so `did-finish-load` is early. */
async function settled(window) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const heading = await window.webContents.executeJavaScript(
      'document.querySelector("h1")?.textContent ?? ""',
    )
    if (heading) return heading
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the page never rendered a heading')
}

async function check(window) {
  for (const path of ['window.desktop?.version', 'window.desktop?.auth?.pair']) {
    const bridged = await window.webContents.executeJavaScript(`typeof ${path} === "function"`)
    if (bridged !== true) throw new Error(`${path} is not exposed`)
  }

  const version = await window.webContents.executeJavaScript('window.desktop.version()')
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`version came back as ${JSON.stringify(version)}`)
  }

  // The status handler reaches the session store, which reaches `safeStorage`.
  // Nothing else here exercises that, and it is the part that differs between a
  // developer's machine and a packaged install.
  const status = await window.webContents.executeJavaScript('window.desktop.auth.status()')
  if (typeof status !== 'object' || status === null || typeof status.paired !== 'boolean') {
    throw new Error(`auth.status() came back as ${JSON.stringify(status)}`)
  }

  const heading = await settled(window)
  // With no pairing stored — which is the state on any machine running this
  // check — the tool opens on the pairing screen.
  const expected = status.paired ? '影片上傳工具' : '連結管理後台'
  if (!heading.includes(expected)) {
    throw new Error(`paired=${status.paired} but the page rendered "${heading}"`)
  }

  return `${version}, paired=${status.paired}, remembered=${status.remembered}`
}

app
  .whenReady()
  // The main bundle registers the IPC handlers and creates the window, so it is
  // imported rather than reimplemented — a copy of that setup here would only
  // prove the copy works.
  .then(() => import('../out/main/index.js'))
  .then(windowAppears)
  .then(async (window) => {
    // Out of the way of whoever is using this machine.
    window.hide()
    await loaded(window)
    const version = await check(window)
    clearTimeout(timer)
    console.log(`smoke: ok — version ${version}, bridge live, page rendered`)
    app.exit(0)
  })
  .catch((error) => {
    clearTimeout(timer)
    fail(error instanceof Error ? error.message : String(error))
  })
