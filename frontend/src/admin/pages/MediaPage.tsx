import { useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { MediaGrid, fileSize, mediaName } from '../components/MediaGrid'
import { MediaSearchField, useMediaLibrary } from '../components/MediaSearch'
import { useStatus } from '../components/StatusBar'
import { Button, EmptyState, Panel, Spinner, TagInput, TextField, useConfirm } from '../components/ui'
import { api, apiJson, apiUrl, uploadMedia } from '../../shared/api'
import type { MediaItem } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/media-admin.css'

type Usage = { id: string; title: string; path: string }

export function MediaPage() {
  const { message, show, showError } = useStatus()
  const { query, setQuery, items, setItems, tags, loadTags, truncated } = useMediaLibrary(true, showError)
  const [selected, setSelected] = useState<MediaItem | null>(null)
  const [usedBy, setUsedBy] = useState<Usage[] | null>(null)
  const [title, setTitle] = useState('')
  const [alt, setAlt] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const { ask, dialog } = useConfirm()
  const file = useRef<HTMLInputElement>(null)

  async function run(work: () => Promise<void>, done: string) {
    if (busy) return
    setBusy(true)
    try {
      await work()
      show(done, 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** Opening an image also asks where it is used, so deleting is informed. */
  async function inspect(item: MediaItem) {
    setSelected(item)
    setTitle(item.title)
    setAlt(item.alt)
    setChosen(item.tags)
    setUsedBy(null)
    try {
      const data = await api<{ item: MediaItem; usedBy: Usage[] }>(`/api/media/${encodeURIComponent(item.id)}`)
      setUsedBy(data.usedBy)
    } catch (error) {
      showError(error)
    }
  }

  function upload(event: Event) {
    const input = event.target as HTMLInputElement
    const picked = input.files?.[0]
    if (!picked) return
    void run(async () => {
      const { item } = await uploadMedia(picked, '')
      setItems((current) => [item, ...(current ?? [])])
      await inspect(item)
      input.value = ''
    }, '圖片已上傳。記得補一句替代文字。')
  }

  function save(event: Event) {
    event.preventDefault()
    if (!selected) return
    void run(async () => {
      const { item } = await apiJson<{ item: MediaItem }>(`/api/media/${encodeURIComponent(selected.id)}`, 'PUT', {
        title,
        alt,
        tags: chosen,
      })
      setItems((current) => (current ?? []).map((entry) => (entry.id === item.id ? item : entry)))
      setSelected(item)
      setChosen(item.tags)
      // A tag invented just now has to be offered to the next image.
      void loadTags()
    }, '已儲存。')
  }

  async function remove() {
    if (!selected) return
    const used = usedBy ?? []
    const name = mediaName(selected)
    const agreed = await ask({
      title: '刪除這張圖？',
      body: used.length ? (
        <>
          <p>
            「{name}」還被 {used.length} 個頁面使用。刪除後那些頁面就少一張圖。
          </p>
          <ul class="usage">
            {used.map((page) => (
              <li key={page.id}>
                {page.title} <code>{page.path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>「{name}」會從媒體庫與儲存空間一併移除，這個動作沒有辦法復原。</p>
      ),
      confirmLabel: '刪除',
    })
    if (!agreed) return

    void run(async () => {
      const params = new URLSearchParams()
      // Saying so twice is what turns a refusal into a deletion.
      if (used.length) params.set('force', '1')
      // The list comes back filtered the same way, so deleting from a search
      // does not throw the search away.
      if (query.trim()) params.set('q', query.trim())
      const search = params.toString()
      const path = `/api/media/${encodeURIComponent(selected.id)}${search ? `?${search}` : ''}`
      const data = await api<{ media: MediaItem[] }>(path, { method: 'DELETE' })
      setItems(data.media)
      setSelected(null)
      setUsedBy(null)
      void loadTags()
    }, '圖片已刪除。')
  }

  return (
    <AdminShell
      current="/media"
      message={message}
      onError={showError}
      actions={
        <Button tone="primary" disabled={busy} onClick={() => file.current?.click()}>
          上傳圖片
        </Button>
      }
    >
      {/* The only raw control on this page: there is no way to open a file
          chooser without one, so it is hidden and the button above opens it. */}
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={upload}
        disabled={busy}
      />

      <section class="stack shop">
        <Panel title="媒體庫">
          <p class="muted">
            上傳一次，輪播、相簿與介紹區塊都能用。區塊記住的是這裡的圖片，不是網址，所以之後換掉檔名也不會斷。jpg、png
            或 webp，最大 5 MB。
          </p>

          <MediaSearchField value={query} onChange={setQuery} />

          {truncated && (
            <p class="muted">只顯示最新的 {items?.length} 張，用搜尋找更舊的。舊的圖片仍然在頁面上正常顯示。</p>
          )}

          {items === null ? (
            <Spinner />
          ) : items.length === 0 && query.trim() ? (
            <EmptyState
              title="沒有符合的圖片"
              body="標籤要打完整才算命中，標題與檔名則是打一部分就好。"
              action={
                <Button tone="ghost" onClick={() => setQuery('')}>
                  清除搜尋
                </Button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState title="媒體庫還是空的" body="上傳第一張圖，之後在頁面的區塊裡就選得到它。" />
          ) : (
            <MediaGrid items={items} selectedId={selected?.id ?? null} onSelect={inspect} />
          )}
        </Panel>

        {selected && (
          <Panel title={mediaName(selected)} class="media-detail">
            <img src={apiUrl(selected.path)} alt={selected.alt} />
            <p class="muted">
              {selected.fileName}．{fileSize(selected.byteSize)}．
              <a href={apiUrl(selected.path)} target="_blank" rel="noopener">
                原圖
              </a>
            </p>

            <form onSubmit={save}>
              <TextField
                label="標題"
                value={title}
                maxLength={120}
                placeholder="你自己要找得到它"
                hint="給你自己看的名字，只用來搜尋。留白就顯示檔名。"
                onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
              />

              <TextField
                label="替代文字"
                value={alt}
                maxLength={200}
                placeholder="看不到圖的人會讀到這句"
                /* Empty is a real answer, so this says so instead of nagging. */
                hint="給顧客的：讀螢幕的人會聽到這句。純裝飾的圖留白就好，讀出檔名比跳過它更吵。"
                onInput={(event) => setAlt((event.target as HTMLInputElement).value)}
              />

              <TagInput
                label="標籤"
                value={chosen}
                options={tags}
                onChange={setChosen}
                max={10}
                maxLength={30}
                hint="一張圖可以同時是「插畫」和「首頁用」，所以這裡沒有資料夾。"
              />

              <Button type="submit" tone="primary" busy={busy}>
                儲存
              </Button>
            </form>

            <h3>用在哪裡</h3>
            {usedBy === null ? (
              <Spinner label="查詢中" />
            ) : usedBy.length === 0 ? (
              <p class="muted">目前沒有頁面使用這張圖。</p>
            ) : (
              <ul class="usage">
                {usedBy.map((page) => (
                  <li key={page.id}>
                    {page.title} <code>{page.path}</code>
                  </li>
                ))}
              </ul>
            )}

            <Button tone="danger" onClick={remove} disabled={busy || usedBy === null}>
              刪除這張圖
            </Button>
          </Panel>
        )}
      </section>

      {dialog}
    </AdminShell>
  )
}
