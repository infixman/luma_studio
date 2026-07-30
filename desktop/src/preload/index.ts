import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only things the interface can ask the operating system for.
 *
 * Deliberately a list of verbs rather than a channel it can send anything down.
 * `ipcRenderer` itself is never exposed: handing it over would make every
 * handler in the main process reachable from the renderer, which is the same as
 * not having a boundary.
 */

const api = {
  /** For the About screen and for the version policy check in S7. */
  version: (): Promise<string> => ipcRenderer.invoke('app:version'),
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('desktop', api)
