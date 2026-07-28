import { apiUrl } from '../../shared/api'
import type { MediaItem } from '../../shared/types'

/**
 * The library as a grid of thumbnails.
 *
 * Presentational on purpose: the library page and the picker show the same
 * images and differ only in what a click means, so the drawing lives here and
 * the meaning stays with the caller.
 */
export function MediaGrid({
  items,
  selectedId,
  onSelect,
  empty = '媒體庫還是空的。',
}: {
  items: MediaItem[]
  selectedId?: string | null
  onSelect: (item: MediaItem) => void
  empty?: string
}) {
  if (items.length === 0) return <p class="muted">{empty}</p>

  return (
    <ul class="media-grid">
      {items.map((item) => (
        <li key={item.id} class={item.id === selectedId ? 'selected' : ''}>
          <button type="button" onClick={() => onSelect(item)} title={mediaName(item)}>
            {/* Alt is the owner's own text. Where it is empty the image is
                decorative, and an empty alt is the right answer — but this is
                the editor, so the name is shown beneath it either way. */}
            <img src={apiUrl(item.path)} alt={item.alt} loading="lazy" />
            <span class="name">{mediaName(item)}</span>
            {!item.alt && <span class="warn">沒有替代文字</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * What to call an image on screen.
 *
 * One function rather than `item.title || item.fileName` written out at each
 * call site: the grid, the picker and the delete prompt all name the same
 * picture, and the moment two of them decide differently the owner is looking
 * for something the library says is called something else.
 */
export function mediaName(item: MediaItem): string {
  return item.title || item.fileName
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
