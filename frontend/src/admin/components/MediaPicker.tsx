import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { MediaGrid } from './MediaGrid'
import { MediaSearchField, useMediaLibrary } from './MediaSearch'
import { Button, Modal, Spinner } from './ui'
import { uploadMedia } from '../../shared/api'
import { prepareUpload } from '../lib/mediaResize'
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

  // Escape, the backdrop and the focus trap belong to Modal — including the
  // two this used to be missing: focus never entered the dialog, and never
  // came back to whatever opened it. Only the "last time's failure is not this
  // time's news" reset is this component's own.
  useEffect(() => {
    if (open) setError('')
  }, [open])

  if (!open) return null

  async function upload(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file || busy) return
    setBusy(true)
    setError('')
    try {
      // The same widths the library page makes. An image put into a page from
      // here is exactly the one a customer loads, so it cannot be the one
      // upload route that quietly skips the responsive copies.
      const { dimensions, variants } = await prepareUpload(file)
      const { item } = await uploadMedia({ file, dimensions, variants })
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
    <Modal
      title="選擇圖片"
      open={open}
      onClose={onClose}
      width="lg"
      footer={
        <>
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
          <span class="muted picker-limit">jpg、png 或 webp，最大 5 MB</span>
          <Button busy={busy} onClick={() => fileInput.current?.click()}>
            上傳新圖
          </Button>
        </>
      }
    >
      <div class="media-picker">
        {error && <p class="ui-note is-error">{error}</p>}

        {/* Above the grid, not at the bottom: it is the first thing you reach
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
      </div>
    </Modal>
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
