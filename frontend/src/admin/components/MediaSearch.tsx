import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { IconButton, TextField } from './ui'
import { api } from '../../shared/api'
import type { MediaItem } from '../../shared/types'

/**
 * The library as something to read and search, shared by the page and the
 * picker.
 *
 * Both of them show the same images and both have to be searchable — the
 * moment you actually cannot find a picture is the moment you are putting one
 * into a page, which happens in the picker. Written once so the two cannot
 * end up searching differently.
 *
 * The search goes to the server. Filtering in the browser would only filter
 * the images already fetched, and the list is capped: past the cap the images
 * that are missing are exactly the old ones nobody can remember the name of.
 */

/** Long enough that typing a word is one request, short enough to feel live. */
const DEBOUNCE_MS = 250

export function useMediaLibrary(active: boolean, onError: (error: unknown) => void) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(
    async (term: string) => {
      try {
        const suffix = term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ''
        const data = await api<{ media: MediaItem[]; truncated: boolean }>(`/api/media${suffix}`)
        setItems(data.media)
        setTruncated(data.truncated)
      } catch (error) {
        // A 401 has already sent the browser to Google; saying so as well
        // would put an error on screen on the way out of the page.
        onError(error)
      }
    },
    [onError],
  )

  const loadTags = useCallback(async () => {
    try {
      setTags((await api<{ tags: string[] }>('/api/media/tags')).tags)
    } catch {
      // Only the suggestions are lost. Typing a tag still works, so this is
      // not worth an error message over.
    }
  }, [])

  useEffect(() => {
    if (!active) return
    clearTimeout(timer.current)
    // The first load is immediate; only keystrokes wait. Otherwise opening the
    // picker shows an empty grid for a quarter of a second every time.
    if (query === '') {
      void load('')
      void loadTags()
      return
    }
    timer.current = setTimeout(() => void load(query), DEBOUNCE_MS)
    return () => clearTimeout(timer.current)
  }, [active, query, load, loadTags])

  return { query, setQuery, items, setItems, tags, loadTags, truncated, reload: () => load(query) }
}

/** The search box itself, so both places offer the same control and wording. */
export function MediaSearchField({
  value,
  onChange,
  hint,
}: {
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <TextField
      label="搜尋"
      type="search"
      value={value}
      placeholder="標題、檔名，或完整的標籤"
      hint={hint ?? '標籤要打完整，所以搜「貓」不會跑出一堆「熊貓」。'}
      onInput={(event) => onChange((event.target as HTMLInputElement).value)}
      trailing={
        value ? (
          <IconButton label="清除搜尋" size="sm" onClick={() => onChange('')}>
            ×
          </IconButton>
        ) : undefined
      }
    />
  )
}
