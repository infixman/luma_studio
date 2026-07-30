/**
 * Run the packaged app's `--self-check` and read what it reported.
 *
 * A packaged app is a different program from `electron-vite dev`: its files are
 * inside an asar archive, `import.meta.dirname` resolves elsewhere, and
 * `app.getPath('userData')` finally means what it will on somebody's machine.
 * Every later feature builds on those paths — where ffmpeg lives, where the
 * resume ledger goes, where the token is kept — so they are worth proving now
 * rather than debugging through a transcoder.
 *
 *   npm run verify:packaged
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const exe = join('dist', 'win-unpacked', 'Luma Video Uploader.exe')

let reportPath
try {
  reportPath = execFileSync(exe, ['--self-check'], { encoding: 'utf8' }).trim().split(/\r?\n/).at(-1)
} catch (error) {
  console.error(`verify:packaged — the app exited non-zero: ${error.message}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))

const problems = []
if (!report.packaged) problems.push('it does not think it is packaged')
if (!report.preload.exists) problems.push(`no preload at ${report.preload.path}`)
if (!report.renderer.exists) problems.push(`no renderer at ${report.renderer.path}`)
// Not a failure: on Linux without a keyring this is false by design, and the
// tool declines to store a token rather than writing one in the clear.
if (!report.canEncryptStorage) console.warn('verify:packaged — no OS encryption; pairing will not persist')

if (problems.length > 0) {
  console.error(`verify:packaged — ${problems.join('; ')}`)
  process.exit(1)
}

console.log(
  `verify:packaged — ok: version ${report.version}, userData ${report.userData}`,
)
