/**
 * What the library says about a picture, in words.
 *
 * These live apart from the components that draw them because the grid, the
 * list, the picker and the delete prompt all describe the same image, and the
 * moment two of them describe it differently the owner is hunting for
 * something the library calls something else.
 */

import { apiUrl } from '../../shared/api'
import type { MediaItem } from '../../shared/types'

/**
 * What to call an image on screen.
 *
 * One function rather than `item.title || item.fileName` written out at each
 * call site: title is the owner's own label and empty is a normal answer, so
 * the file name is the fallback everywhere or nowhere.
 */
export function mediaName(item: MediaItem): string {
  return item.title || item.fileName
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * PNG, JPG or WEBP, from the name.
 *
 * The extension rather than a stored content type, because the extension is
 * what the upload was accepted on: nothing can be in the library whose name
 * disagrees with what it is.
 */
export function mediaFormat(item: MediaItem): string {
  const dot = item.fileName.lastIndexOf('.')
  if (dot < 0) return ''
  return item.fileName.slice(dot + 1).toUpperCase()
}

export function mediaDimensions(item: MediaItem): string {
  // Zero means nobody measured it — an upload from before the browser started
  // to, or a file it could not decode. Saying 0×0 would be worse than silence.
  return item.width && item.height ? `${item.width}×${item.height}` : ''
}

/**
 * The line under a thumbnail: `PNG · 1024×1024`.
 *
 * The shop sells illustrations, so the format and the shape are what the owner
 * is actually looking for — a transparent PNG and a flattened JPG of the same
 * drawing are different pictures.
 */
export function mediaCaption(item: MediaItem): string {
  return [mediaFormat(item), mediaDimensions(item)].filter(Boolean).join(' · ')
}

export function mediaDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/**
 * The srcset for an image, widths and all, with the original as the last entry.
 *
 * The original is always in it. The stored widths stop below the original's
 * own, so without it a large screen would be given the 1600px copy of a
 * 4000px scan and nothing wider would exist.
 *
 * An image with no stored widths returns an empty string rather than a srcset
 * of one, because a one-entry srcset is what `src` already says.
 */
export function mediaSrcSet(item: MediaItem): string {
  if (item.sizes.length === 0) return ''
  const entries = item.sizes.map((size) => `${apiUrl(size.path)} ${size.width}w`)
  if (item.width) entries.push(`${apiUrl(item.path)} ${item.width}w`)
  return entries.join(', ')
}
