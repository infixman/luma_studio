import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

/**
 * Small things the tool remembers between launches.
 *
 * Kept apart from `store.ts`, which holds the pairing token, because these are
 * not secrets and the two want opposite treatment: the token is encrypted and is
 * simply not stored where encryption is unavailable, while a remembered email
 * address is a convenience worth keeping on any machine.
 *
 * Mixing them would mean either encrypting a preference for no reason or
 * declining to remember one on a machine where the token cannot be kept.
 */

export interface Prefs {
  /** Empty when the admin has not asked for it to be remembered. */
  rememberedEmail: string
}

const EMPTY: Prefs = { rememberedEmail: '' }

function path(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

export function read(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as Partial<Prefs>
    return {
      rememberedEmail: typeof raw.rememberedEmail === 'string' ? raw.rememberedEmail : '',
    }
  } catch {
    // Absent, half-written, or from an older shape. Forgetting a preference is
    // a minor annoyance; failing to launch over one is not.
    return EMPTY
  }
}

export function rememberEmail(email: string): void {
  write({ rememberedEmail: email })
}

export function forgetEmail(): void {
  write({ rememberedEmail: '' })
}

function write(prefs: Prefs): void {
  try {
    writeFileSync(path(), JSON.stringify(prefs))
  } catch {
    // Same reasoning as above.
  }
}
