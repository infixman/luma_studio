import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { PairingInput } from '../shared/pairing'
import type { SessionStatus } from '../shared/session'
import type { Progress, ScanResult, StorageListing, UploadRequest, UploadResult } from '../shared/upload'

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

  /**
   * The real path of a dropped file.
   *
   * `File.path` was removed from Electron, and this is its replacement. It has
   * to be called on this side of the bridge: `webUtils` is not something the
   * renderer may have, because a page that can ask for the path of any File it
   * constructs is a page that can go looking around the disk.
   */
  pathFor: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  /**
   * What is on the clipboard.
   *
   * Read in the main process: `navigator.clipboard.readText` in a sandboxed
   * renderer depends on focus and permission state, and when it refuses the
   * symptom is a paste button that quietly does nothing.
   */
  clipboard: (): Promise<string> => ipcRenderer.invoke('app:clipboard'),

  prefs: {
    read: (): Promise<{ rememberedEmail: string }> => ipcRenderer.invoke('prefs:read'),
    rememberEmail: (email: string): Promise<{ rememberedEmail: string }> =>
      ipcRenderer.invoke('prefs:rememberEmail', email),
  },

  auth: {
    status: (): Promise<SessionStatus> => ipcRenderer.invoke('auth:status'),
    pair: (input: PairingInput): Promise<PairResult> => ipcRenderer.invoke('auth:pair', input),
    signOut: (): Promise<SessionStatus> => ipcRenderer.invoke('auth:signOut'),
  },

  upload: {
    scan: (folder: string): Promise<ScanResult> => ipcRenderer.invoke('upload:scan', folder),
    start: (request: UploadRequest): Promise<UploadResult> =>
      ipcRenderer.invoke('upload:start', request),

    /** Kills ffmpeg, rather than stopping listening to it. */
    cancel: (): Promise<void> => ipcRenderer.invoke('upload:cancel'),

    /**
     * Progress, as events rather than a promise. An upload is minutes long.
     *
     * Returns its own unsubscribe rather than exposing `removeListener`, so the
     * renderer cannot detach a listener it did not add.
     */
    onProgress: (listener: (progress: Progress) => void): (() => void) => {
      const wrapped = (_event: unknown, progress: Progress): void => listener(progress)
      ipcRenderer.on('upload:progress', wrapped)
      return () => ipcRenderer.removeListener('upload:progress', wrapped)
    },

    /** Read-only, and the only question this tool asks about the bucket. */
    listStorage: (options: { prefix: string; kind?: 'source' | 'output' }): Promise<StorageListing> =>
      ipcRenderer.invoke('storage:list', options),
  },
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('desktop', api)
