import { useEffect, useRef, useState } from 'preact/hooks'

import { MediaGrid } from './MediaGrid'
import { api, uploadMedia } from '../../shared/api'
import type { MediaItem } from '../../shared/types'

/**
 * Choosing an image from the library, or adding one on the spot.
 *
 * Blocks store a media id, so this hands back the whole item and the caller
 * keeps whichever part it needs — the id to save, the URL to draw.
 *
 * Uploading is here as well as on the library page. Making the owner leave a
 * half-finished carousel to go and upload a photo is how a half-finished
 * carousel gets saved.
 */
export function MediaPicker({
  open,
  selectedId,
  onPick,
  onClose,
}: {
  open: boolean
  selectedId?: string | null
  onPick: (item: MediaItem) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setError('')
    api<{ media: MediaItem[] }>('/api/media')
      .then((data) => setItems(data.media))
      .catch((problem) => setError(problem instanceof Error ? problem.message : '媒體庫載入失敗'))
  }, [open])

  // Escape closes it, because a dialog that can only be dismissed by finding
  // the right button is a dialog people click through to get rid of.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      const { item } = await uploadMedia(file, '')
      setItems((current) => [item, ...(current ?? [])])
      onPick(item)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '上傳失敗')
    } finally {
      setBusy(false)
      input.value = ''
    }
  }

  return (
    <div class="media-picker" role="dialog" aria-modal="true" aria-label="選擇圖片">
      <div class="backdrop" onClick={onClose} />
      <div class="panel">
        <header>
          <h3>選擇圖片</h3>
          <button type="button" class="ghost" onClick={onClose}>
            關閉
          </button>
        </header>

        {error && <p class="error">{error}</p>}

        <div class="body">
          {items === null ? (
            <p class="muted">載入中…</p>
          ) : (
            <MediaGrid items={items} selectedId={selectedId} onSelect={onPick} empty="媒體庫還是空的，先上傳一張。" />
          )}
        </div>

        <footer>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={upload}
            disabled={busy}
          />
          <span class="muted">jpg、png 或 webp，最大 5 MB</span>
        </footer>
      </div>
    </div>
  )
}
