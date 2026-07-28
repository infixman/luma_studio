import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { MediaGrid } from './MediaGrid'
import { MediaSearchField, useMediaLibrary } from './MediaSearch'
import { Button, Spinner } from './ui'
import { uploadMedia } from '../../shared/api'
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
 *
 * Searching is here for the same kind of reason, and it is the more important
 * half: the library page is where you tidy up, but this is where you are
 * looking for one particular picture among two hundred.
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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const report = useCallback(
    (problem: unknown) => setError(problem instanceof Error ? problem.message : '媒體庫載入失敗'),
    [],
  )
  const { query, setQuery, items, setItems } = useMediaLibrary(open, report)

  // Escape closes it, because a dialog that can only be dismissed by finding
  // the right button is a dialog people click through to get rid of.
  useEffect(() => {
    if (!open) return
    // Last time's failure is not this time's news.
    setError('')
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
          <Button tone="ghost" onClick={onClose}>
            關閉
          </Button>
        </header>

        {error && <p class="error">{error}</p>}

        {/* Above the grid, not in the footer: it is the first thing you reach
            for once the library has more images than fit on one screen. */}
        <div class="search">
          <MediaSearchField value={query} onChange={setQuery} />
        </div>

        <div class="body">
          {items === null ? (
            <Spinner />
          ) : (
            <MediaGrid
              items={items}
              selectedId={selectedId}
              onSelect={onPick}
              empty={query.trim() ? '沒有符合的圖片。標籤要打完整，標題與檔名打一部分就好。' : '媒體庫還是空的，先上傳一張。'}
            />
          )}
        </div>

        <footer>
          {/* Hidden, because a file chooser is the one control the kit cannot
              draw — the button in front of it is the one that matches. */}
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={upload}
            disabled={busy}
          />
          <Button busy={busy} onClick={() => fileInput.current?.click()}>
            上傳新圖
          </Button>
          <span class="muted">jpg、png 或 webp，最大 5 MB</span>
        </footer>
      </div>
    </div>
  )
}

/**
 * The picker as something to await.
 *
 * A block editor wants one line — "give me an image" — not a piece of state
 * per slide tracking which control opened the dialog. So the promise is held
 * here and settled when the owner picks or dismisses.
 */
export function useMediaPicker() {
  const [pending, setPending] = useState<{ resolve: (item: MediaItem | null) => void } | null>(null)

  const request = useCallback(
    () => new Promise<MediaItem | null>((resolve) => setPending({ resolve })),
    [],
  )

  const settle = (item: MediaItem | null) => {
    pending?.resolve(item)
    setPending(null)
  }

  const element = (
    <MediaPicker open={pending !== null} onPick={(item) => settle(item)} onClose={() => settle(null)} />
  )

  return { request, element }
}
