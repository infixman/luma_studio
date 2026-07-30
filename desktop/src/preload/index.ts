import { contextBridge, ipcRenderer } from 'electron'

import type { PairingInput } from '../shared/pairing'
import type { SessionStatus } from '../shared/session'

/**
 * The only things the interface can ask the operating system for.
 *
 * Deliberately a list of verbs rather than a channel it can send anything down.
 * `ipcRenderer` itself is never exposed: handing it over would make every
 * handler in the main process reachable from the renderer, which is the same as
 * not having a boundary.
 *
 * Note what is absent — there is no way to read the pairing token. The renderer
 * gets facts about the session, and requests that need the token are made on the
 * other side of this file.
 */

export interface PairResult {
  ok: boolean
  status?: SessionStatus
  message?: string
  httpStatus?: number | null
}

const api = {
  /** For the About screen and for the version policy check in S7. */
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),

  auth: {
    status: (): Promise<SessionStatus> => ipcRenderer.invoke('auth:status'),
    pair: (input: PairingInput): Promise<PairResult> => ipcRenderer.invoke('auth:pair', input),
    signOut: (): Promise<SessionStatus> => ipcRenderer.invoke('auth:signOut'),
  },
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('desktop', api)
