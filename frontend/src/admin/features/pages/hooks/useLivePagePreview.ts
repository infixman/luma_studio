import { useCallback, useState } from 'preact/hooks'

import { STOREFRONT_ORIGIN, apiJson } from '../../../../shared/api'

/** Owns single-use preview tokens and the iframe URL they create. */
export function useLivePagePreview(pageId: string, showError: (error: unknown) => void) {
  const [frame, setFrame] = useState<string | null>(null)
  const [framing, setFraming] = useState(false)

  const openLivePreview = useCallback(async () => {
    if (framing) return
    setFraming(true)
    try {
      const { token } = await apiJson<{ token: string }>(
        `/api/pages/${encodeURIComponent(pageId)}/preview-token`,
        'POST',
        {},
      )
      setFrame(`${STOREFRONT_ORIGIN}/__preview/${encodeURIComponent(token)}`)
    } catch (error) {
      showError(error)
    } finally {
      setFraming(false)
    }
  }, [framing, pageId, showError])

  return { frame, framing, openLivePreview }
}
