import { useEffect, useRef, useState } from 'preact/hooks'

import { fileSize } from '../../shared/bytes'
import type { StorageListing } from '../../shared/upload'

/**
 * What the bucket actually holds for this video.
 *
 * The server already verified every object before answering `ready`, so this is
 * not a second check — it is the answer to "did it really go", asked from the
 * machine that did the uploading and answered by the bucket rather than by this
 * program. Read-only and behind a button: it costs a listing, and the reason to
 * look is curiosity or disbelief rather than routine.
 */
export function StoredObjects({ assetId }: { assetId: string }) {
  const [listing, setListing] = useState<StorageListing | null>(null)
  const [asking, setAsking] = useState(false)
  // A listing that answers after the screen moved on must not set state into
  // nothing — dropping another file while this is in flight is ordinary.
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])

  if (!listing) {
    return (
      <button
        type="button"
        class="ghost"
        disabled={asking}
        onClick={() => {
          setAsking(true)
          void window.desktop.upload
            .listStorage({ prefix: `videos/${assetId}/`, kind: 'output' })
            .then((answer) => {
              if (mounted.current) setListing(answer)
            })
            // The bridge rejects when the main process itself fails, which is
            // rarer than a refusal but not impossible — and an unhandled
            // rejection here is a button that stays "讀取中…" forever.
            .catch((error: unknown) => {
              if (mounted.current) {
                setListing({ ok: false, message: error instanceof Error ? error.message : '讀取失敗' })
              }
            })
            .finally(() => {
              if (mounted.current) setAsking(false)
            })
        }}
      >
        {asking ? '讀取中…' : '確認檔案在儲存空間裡'}
      </button>
    )
  }

  if (!listing.ok) {
    // Not an empty list. "Nothing is there" and "we could not look" are opposite
    // answers to the question this button asks.
    return <p class="alert">{listing.message}</p>
  }

  const bytes = listing.objects.reduce((total, object) => total + object.size, 0)
  return (
    <p class="muted">
      儲存空間裡有 {listing.objects.length} 個檔案，共 {fileSize(bytes)}。
    </p>
  )
}
