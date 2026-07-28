import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { MediaGrid, fileSize } from '../components/MediaGrid'
import { useStatus } from '../components/StatusBar'
import { Button, EmptyState, Panel, Spinner, TextField, useConfirm } from '../components/ui'
import { ApiError, api, apiJson, apiUrl, clearLoginAttempt, uploadMedia } from '../../shared/api'
import type { MediaItem } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/media-admin.css'

type Usage = { id: string; title: string; path: string }

export function MediaPage() {
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [selected, setSelected] = useState<MediaItem | null>(null)
  const [usedBy, setUsedBy] = useState<Usage[] | null>(null)
  const [alt, setAlt] = useState('')
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      const data = await api<{ media: MediaItem[]; truncated: boolean }>('/api/media')
      setItems(data.media)
      setTruncated(data.truncated)
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

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
    setAlt(item.alt)
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
    const file = input.files?.[0]
    if (!file) return
    void run(async () => {
      const { item } = await uploadMedia(file, '')
      setItems((current) => [item, ...(current ?? [])])
      await inspect(item)
      input.value = ''
    }, '圖片已上傳。記得補一句替代文字。')
  }

  function saveAlt(event: Event) {
    event.preventDefault()
    if (!selected) return
    void run(async () => {
      const { item } = await apiJson<{ item: MediaItem }>(
        `/api/media/${encodeURIComponent(selected.id)}`,
        'PUT',
        { alt },
      )
      setItems((current) => (current ?? []).map((entry) => (entry.id === item.id ? item : entry)))
      setSelected(item)
    }, '替代文字已儲存。')
  }

  async function remove() {
    if (!selected) return
    const used = usedBy ?? []
    // The pages are listed rather than counted. This is the prompt that most
    // wanted a dialog: "還被 3 個頁面使用" is not enough to decide with.
    const ok = await ask({
      title: '刪除圖片',
      body: used.length ? (
        <>
          <p>
            「{selected.fileName}」還被 {used.length} 個頁面使用：
          </p>
          <ul class="usage">
            {used.map((page) => (
              <li key={page.id}>
                {page.title} <code>{page.path}</code>
              </li>
            ))}
          </ul>
          <p>刪除之後，那些頁面就少一張圖。</p>
        </>
      ) : (
        <p>確定要刪除「{selected.fileName}」嗎？目前沒有頁面使用它。</p>
      ),
      confirmLabel: '刪除圖片',
    })
    if (!ok) return

    void run(async () => {
      const suffix = used.length ? '?force=1' : ''
      const data = await api<{ media: MediaItem[] }>(
        `/api/media/${encodeURIComponent(selected.id)}${suffix}`,
        { method: 'DELETE' },
      )
      setItems(data.media)
      setSelected(null)
      setUsedBy(null)
    }, '圖片已刪除。')
  }

  return (
    <AdminShell current="/media" message={message} onError={showError}>
      {dialog}

      <Panel title="媒體庫">
        <p class="muted">
          上傳一次，輪播、相簿與介紹區塊都能用。區塊記住的是這裡的圖片，不是網址，所以之後換掉檔名也不會斷。
        </p>
        <label class="upload">
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={upload} disabled={busy} />
          <span class="muted">jpg、png 或 webp，最大 5 MB</span>
        </label>

        {truncated && <p class="muted warn">只顯示最新的 {items?.length} 張。舊的圖片仍然在頁面上正常顯示。</p>}

        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="媒體庫是空的" body="上傳第一張圖之後，它就能被輪播、相簿與介紹區塊選用。" />
        ) : (
          <MediaGrid items={items} selectedId={selected?.id ?? null} onSelect={inspect} />
        )}
      </Panel>

      {selected && (
        <Panel
          title={selected.fileName}
          class="media-detail"
          actions={
            <Button tone="danger" size="sm" onClick={() => void remove()} disabled={busy || usedBy === null}>
              刪除這張圖
            </Button>
          }
        >
          <img src={apiUrl(selected.path)} alt={selected.alt} />
          <p class="muted">
            {fileSize(selected.byteSize)}．
            <a href={apiUrl(selected.path)} target="_blank" rel="noopener">
              原圖
            </a>
          </p>

          <form onSubmit={saveAlt}>
            <TextField
              label="替代文字"
              value={alt}
              onInput={(event) => setAlt((event.currentTarget as HTMLInputElement).value)}
              maxLength={200}
              placeholder="看不到圖的人會讀到這句"
              // Empty is a real answer, so this says so instead of nagging.
              hint="純裝飾的圖留白就好，讓讀螢幕的人跳過它，比讀出檔名好。"
            />
            <Button type="submit" tone="primary" busy={busy}>
              儲存替代文字
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
        </Panel>
      )}
    </AdminShell>
  )
}
