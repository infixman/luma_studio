import { useEffect, useState } from 'preact/hooks'

import { CLIPBOARD_KEY, readCopiedBlock } from '../../../lib/blockClipboard'
import type { CopiedBlock } from '../../../lib/blockClipboard'
import type { PageBlock } from '../../../../shared/types'

/** Keeps the editor's paste affordance in sync with cross-tab storage. */
export function useBlockClipboard(knownTypes: PageBlock['type'][]) {
  const [clipboard, setClipboard] = useState<CopiedBlock | null>(null)

  useEffect(() => {
    const refresh = () => setClipboard(readCopiedBlock(knownTypes))
    refresh()
    const moved = (event: StorageEvent) => {
      if (event.key === null || event.key === CLIPBOARD_KEY) refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('storage', moved)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('storage', moved)
    }
  }, [knownTypes])

  return { clipboard, setClipboard }
}
