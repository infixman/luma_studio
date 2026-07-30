/// <reference types="vite/client" />

import type { DesktopApi } from '../../preload'

declare global {
  interface Window {
    /**
     * Everything the interface may ask the operating system for. Exposed by the
     * preload script, which is the whole of the boundary — see `src/preload`.
     */
    desktop: DesktopApi
  }
}
