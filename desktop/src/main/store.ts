import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, safeStorage } from 'electron'

import { parseSession, type Session } from '../shared/session'

/**
 * Keeping the pairing token between launches, or declining to.
 *
 * The token is a bearer credential with a twelve-hour life. Written in the clear
 * it is a file anything running as this user can read, which is most of what a
 * token being short-lived was supposed to prevent — so it goes through
 * `safeStorage`, which on Windows is DPAPI keyed to the user account.
 *
 * **Where encryption is unavailable, nothing is stored at all.** That happens on
 * Linux without a keyring, and the alternative would be writing a plaintext
 * credential to disk on exactly the machines least able to protect it. The cost
 * is pairing again after each launch, which is a nuisance rather than a risk.
 */

const FILE = 'pairing.bin'

function path(): string {
  return join(app.getPath('userData'), FILE)
}

export function canPersist(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function load(): Session | null {
  if (!canPersist()) return null
  try {
    const decrypted = safeStorage.decryptString(readFileSync(path()))
    return parseSession(JSON.parse(decrypted))
  } catch {
    // No file, a file from another user account, a file written by an older
    // version, a truncated write. Every one of them recovers the same way, and
    // none of them is worth a dialog on launch.
    return null
  }
}

export function save(session: Session): void {
  if (!canPersist()) return
  try {
    writeFileSync(path(), safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 })
  } catch {
    // Failing to remember is not failing to work. The session stays in memory
    // for this run either way.
  }
}

export function clear(): void {
  try {
    rmSync(path(), { force: true })
  } catch {
    // Already gone, or not ours to remove.
  }
}
