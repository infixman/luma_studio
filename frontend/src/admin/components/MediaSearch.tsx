import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { IconButton, TextField } from './ui'
import { api } from '../../shared/api'
import type { MediaItem, PageInfo } from '../../shared/types'
import { useLatest } from '../lib/latest'

/**
 * The library as something to read and search, shared by the page and the
 * picker.
 *
 * Both of them show the same images and both have to be searchable — the
 * moment you actually cannot find a picture is the moment you are putting one
 * into a page, which happens in the picker. Written once so the two cannot
 * end up searching differently.
 *
 * The search goes to the server, and so does the paging. Filtering in the
 * browser would only ever filter the page the browser happens to be holding,
 * and the images not on it are exactly the old ones nobody can remember the
 * name of.
 */

/** Long enough that typing a word is one request, short enough to feel live. */
const DEBOUNCE_MS = 250

export function useMediaLibrary(active: boolean, onError: (error: unknown) => void) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [info, setInfo] = useState<PageInfo | null>(null)
  const [page, setPage] = useState(1)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useLatest()

  const load = useCallback(
    (term: string, wanted: number) =>
      latest(async (isCurrent) => {
        try {
          const query = new URLSearchParams({ page: String(wanted) })
          if (term.trim()) query.set('q', term.trim())
          const data = await api<{ media: MediaItem[] } & PageInfo>(`/api/media?${query}`)
          if (!isCurrent()) return
          setItems(data.media)
          setInfo(data)
        } catch (error) {
          // Only the current request may report. An older one failing says
          // nothing about what is on screen now.
          if (isCurrent()) onError(error)
        }
      }),
    [latest, onError],
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
      void load('', page)
      void loadTags()
      return
    }
    timer.current = setTimeout(() => void load(query, page), DEBOUNCE_MS)
    return () => clearTimeout(timer.current)
  }, [active, query, page, load, loadTags])

  /** A new search is a different library, so it starts at its own first page. */
  const search = useCallback((term: string) => {
    setQuery(term)
    setPage(1)
  }, [])

  return {
    query,
    setQuery: search,
    items,
    setItems,
    tags,
    loadTags,
    info,
    page,
    setPage,
    reload: () => load(query, page),
  }
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
