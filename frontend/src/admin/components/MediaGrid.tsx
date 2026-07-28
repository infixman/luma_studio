import { Checkbox, TableWrap } from './ui'
import { apiUrl } from '../../shared/api'
import { srcSetFor } from '../../shared/srcset'
import {
  fileSize,
  mediaCaption,
  mediaDimensions,
  mediaFormat,
  mediaName,
} from '../lib/mediaFacts'
import type { MediaItem } from '../../shared/types'
import { dateOnly } from '../../shared/dates'

/**
 * The library, as a grid of thumbnails or as a table.
 *
 * Presentational on purpose: the library page and the picker show the same
 * images and differ only in what a click means, so the drawing lives here and
 * the meaning stays with the caller. The picker passes no selection, which is
 * how the same card is a tick-box in one place and a plain choice in the
 * other.
 */

export type MediaView = 'grid' | 'list'

export interface MediaSelection {
  chosen: ReadonlySet<string>
  onToggle: (id: string, chosen: boolean) => void
}

interface ListProps {
  items: MediaItem[]
  selectedId?: string | null
  onSelect: (item: MediaItem) => void
  /** Absent in the picker: you are choosing one image there, not a batch. */
  selection?: MediaSelection
  empty?: string
}

export function MediaGrid({ items, selectedId, onSelect, selection, empty = '媒體庫還是空的。' }: ListProps) {
  if (items.length === 0) return <p class="muted">{empty}</p>

  return (
    <ul class="media-grid">
      {items.map((item) => (
        <li
          key={item.id}
          class={[item.id === selectedId ? 'selected' : '', selection?.chosen.has(item.id) ? 'chosen' : '']
            .filter(Boolean)
            .join(' ')}
        >
          {selection && (
            /* Outside the button rather than inside it: a checkbox within a
               button is neither valid nor reachable, and ticking one must not
               also open the image. */
            <span class="media-pick">
              <Checkbox
                label={<span class="media-pick-label">{`選取 ${mediaName(item)}`}</span>}
                checked={selection.chosen.has(item.id)}
                onChange={(checked) => selection.onToggle(item.id, checked)}
              />
            </span>
          )}
          <button type="button" onClick={() => onSelect(item)} title={mediaName(item)}>
            {/* The grid is auto-fill minmax(150px, 1fr), so a cell stretches
                up to just under 300px before another column fits. Stating the
                floor made the browser fetch the 150 and draw it at 290. */}
            <Thumbnail item={item} sizes="300px" />
            <span class="name">{mediaName(item)}</span>
            {/* PNG · 1024×1024. The shop sells illustrations, so the format and
                the shape are half of what tells two files apart. */}
            <span class="meta">{mediaCaption(item)}</span>
            {!item.alt && <span class="warn">沒有替代文字</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The same images with the facts spelled out in columns.
 *
 * A grid answers "which one is it"; this answers "which of these is the 4 MB
 * one" and "what did I upload last Tuesday", which a wall of thumbnails
 * cannot be sorted or scanned for.
 */
export function MediaTable({ items, selectedId, onSelect, selection, empty = '媒體庫還是空的。' }: ListProps) {
  if (items.length === 0) return <p class="muted">{empty}</p>

  return (
    <TableWrap>
      <thead>
        <tr>
          {selection && <th class="media-tick" />}
          <th>名稱</th>
          <th>格式</th>
          <th class="numeric">大小</th>
          <th>尺寸</th>
          <th>上傳日期</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} class={item.id === selectedId ? 'selected' : ''}>
            {selection && (
              <td class="media-tick">
                <Checkbox
                  label={<span class="media-pick-label">{`選取 ${mediaName(item)}`}</span>}
                  checked={selection.chosen.has(item.id)}
                  onChange={(checked) => selection.onToggle(item.id, checked)}
                />
              </td>
            )}
            <td>
              <button type="button" class="media-row-name" onClick={() => onSelect(item)}>
                <span class="media-row-thumb">
                  <Thumbnail item={item} sizes="44px" />
                </span>
                <span>
                  {mediaName(item)}
                  {!item.alt && <small class="warn">沒有替代文字</small>}
                </span>
              </button>
            </td>
            <td>{mediaFormat(item)}</td>
            <td class="numeric">{fileSize(item.byteSize)}</td>
            <td>{mediaDimensions(item) || '—'}</td>
            <td>{dateOnly(item.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  )
}

/**
 * A thumbnail on a checkerboard, fitted rather than cropped.
 *
 * `contain`, not `cover`. The shop sells illustrations: transparency and
 * aspect ratio are information about the file, and cropping to a square lies
 * about both — a tall drawing is not a square one, and a white background is
 * not the same picture as no background at all. The checkerboard behind it is
 * the difference between the two.
 */
function Thumbnail({ item, sizes }: { item: MediaItem; sizes: string }) {
  return (
    <span class="media-thumb">
      {/* Alt is the owner's own text. Where it is empty the image is
          decorative, and an empty alt is the right answer — but this is the
          editor, so the name is shown beside it either way. */}
      <img
        src={apiUrl(item.path)}
        srcset={srcSetFor(item)}
        sizes={sizes}
        alt={item.alt}
        loading="lazy"
        decoding="async"
      />
    </span>
  )
}
