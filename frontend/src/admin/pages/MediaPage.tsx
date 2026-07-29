import { useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { MediaGrid, MediaTable, type MediaView } from '../components/MediaGrid'
import { MediaSearchField, useMediaLibrary } from '../components/MediaSearch'
import { useStatus } from '../components/StatusBar'
import {
  Button,
  ButtonRow,
  Checkbox,
  EmptyState,
  Modal,
  Pagination,
  Panel,
  Spinner,
  TagInput,
  TextField,
  useConfirm,
} from '../components/ui'
import { api, apiJson, apiUrl, uploadMedia } from '../../shared/api'
import { srcSetFor } from '../../shared/srcset'
import { fileSize, mediaDimensions, mediaFormat, mediaName } from '../lib/mediaFacts'
import { prepareUpload } from '../lib/mediaResize'
import type { MediaItem } from '../../shared/types'
import '../styles/media-admin.css'
import { dateOnly } from '../../shared/dates'

type Usage = { id: string; title: string; path: string }

/** One file inside a batch, so a failure names itself instead of the batch. */
type UploadTask = { key: number; name: string; ratio: number; state: 'working' | 'done' | 'failed'; error?: string }

export function MediaPage() {
  const { message, showError, busy, run } = useStatus()
  const { query, setQuery, items, setItems, tags, loadTags, info, page, setPage } = useMediaLibrary(true, showError)
  const [selected, setSelected] = useState<MediaItem | null>(null)
  /** The usage lookup failed, so the dialog says so instead of pretending. */
  const [usageFailed, setUsageFailed] = useState(false)
  const [usedBy, setUsedBy] = useState<Usage[] | null>(null)
  const [title, setTitle] = useState('')
  const [alt, setAlt] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [view, setView] = useState<MediaView>('grid')
  const [picked, setPicked] = useState<string[]>([])
  const [uploads, setUploads] = useState<UploadTask[]>([])
  const [dragging, setDragging] = useState(false)
  const { ask, dialog } = useConfirm()
  const file = useRef<HTMLInputElement>(null)

  const shown = items ?? []
  // Only what is on screen counts as picked. A search narrows the grid, and
  // deleting something the owner cannot currently see is not a batch — it is
  // a surprise.
  const pickedHere = shown.filter((item) => picked.includes(item.id))
  const allPicked = shown.length > 0 && pickedHere.length === shown.length

  /** Opening an image also asks where it is used, so deleting is informed. */
  async function inspect(item: MediaItem) {
    setSelected(item)
    setTitle(item.title)
    setAlt(item.alt)
    setChosen(item.tags)
    setUsedBy(null)
    setUsageFailed(false)
    try {
      const data = await api<{ item: MediaItem; usedBy: Usage[] }>(`/api/media/${encodeURIComponent(item.id)}`)
      setUsedBy(data.usedBy)
    } catch (error) {
      // A blip here used to leave the delete button disabled with nothing
      // said, and nothing that would ever re-enable it short of closing the
      // panel and opening it again. Deleting stays possible: the server does
      // its own usage check and answers 409, so the safety is not this list.
      setUsageFailed(true)
      showError(error)
    }
  }

  function togglePicked(id: string, on: boolean) {
    setPicked((current) => (on ? [...current, id] : current.filter((entry) => entry !== id)))
  }

  function togglePickedAll(on: boolean) {
    setPicked(on ? shown.map((item) => item.id) : [])
  }

  /**
   * Upload a batch, one file at a time.
   *
   * Sequential rather than all at once for two reasons: the decoded bitmap of
   * a twelve megapixel photograph is real memory and twenty of them at once is
   * a tab that dies, and a progress bar per file only means anything if the
   * files take turns.
   *
   * A failure marks that one file and the loop carries on. Twenty photographs
   * where the eleventh is a HEIC the browser will not take should leave
   * nineteen uploaded, not a batch to start again.
   */
  function acceptFiles(list: FileList | null) {
    const chosenFiles = [...(list ?? [])]
    if (chosenFiles.length === 0) return
    const started = Date.now()
    void run(async () => {
      setUploads(
        chosenFiles.map((entry, index) => ({ key: started + index, name: entry.name, ratio: 0, state: 'working' })),
      )
      let done = 0
      let failed = 0
      for (const [index, entry] of chosenFiles.entries()) {
        const key = started + index
        const update = (patch: Partial<UploadTask>) =>
          setUploads((current) => current.map((task) => (task.key === key ? { ...task, ...patch } : task)))
        try {
        // The responsive widths, and with them the EXIF rotation — see
        // prepareUpload: the decoder applies the orientation tag, so a photo
        // taken sideways is stored the right way up.
        const { dimensions, variants } = await prepareUpload(entry)
        const { item } = await uploadMedia({ file: entry, dimensions, variants }, (ratio) => update({ ratio }))
        setItems((current) => [item, ...(current ?? [])])
        update({ ratio: 1, state: 'done' })
        done += 1
        } catch (error) {
          update({ state: 'failed', error: error instanceof Error ? error.message : '上傳失敗' })
          failed += 1
        }
      }
      // The finished rows go; the failed ones stay on screen, because a file
      // that did not upload is the only thing left to act on.
      setUploads((current) => current.filter((task) => task.state === 'failed'))
      if (failed === 0) return
      return done === 0 ? `${failed} 張都沒有上傳成功。` : `已上傳 ${done} 張，${failed} 張失敗。`
    }, `已上傳 ${chosenFiles.length} 張。記得補上替代文字。`)
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

  /** The query string that keeps a filtered list filtered across a delete. */
  /**
   * The query the grid is currently showing, so that a route which answers
   * with the library after changing it answers with the *same* page.
   *
   * Without the page number a delete on page 3 came back with page 1, and the
   * grid jumped to the top of the library.
   */
  function searchParam(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ ...extra, page: String(page) })
    if (query.trim()) params.set('q', query.trim())
    return `?${params}`
  }

  async function remove() {
    if (!selected) return
    const used = usedBy ?? []
    const name = mediaName(selected)
    const agreed = await ask({
      title: '刪除這張圖？',
      body: usageFailed ? (
        <p>
          「{name}」會從媒體庫與儲存空間一併移除。剛才查不到哪些頁面正在使用它，所以這裡沒辦法先告訴你——如果還有頁面用著，刪除會被擋下來。
        </p>
      ) : used.length ? (
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
      // Saying so twice is what turns a refusal into a deletion.
      const path = `/api/media/${encodeURIComponent(selected.id)}${searchParam(used.length ? { force: '1' } : {})}`
      const data = await api<{ media: MediaItem[] }>(path, { method: 'DELETE' })
      setItems(data.media)
      setPicked((current) => current.filter((id) => id !== selected.id))
      setSelected(null)
      setUsedBy(null)
      void loadTags()
    }, '圖片已刪除。')
  }

  /**
   * Delete everything ticked, behind one question.
   *
   * The usage of the whole selection is fetched before the question is asked,
   * so the dialog can name the pictures and the pages still using them in the
   * same breath. Finding that out afterwards would mean a second dialog for
   * something the owner has already decided.
   */
  async function removePicked() {
    if (pickedHere.length === 0 || busy) return
    const ids = pickedHere.map((item) => item.id)

    let usage: Record<string, Usage[]> = {}
    try {
      const data = await api<{ usage: Record<string, Usage[]> }>(
        `/api/media/usage?ids=${encodeURIComponent(ids.join(','))}`,
      )
      usage = data.usage
    } catch (error) {
      showError(error)
      return
    }
    const inUse = pickedHere.filter((item) => (usage[item.id] ?? []).length > 0)

    const agreed = await ask({
      title: `刪除 ${ids.length} 張圖？`,
      body: (
        <>
          <p>以下圖片會從媒體庫與儲存空間一併移除，這個動作沒有辦法復原。</p>
          <ul class="usage">
            {pickedHere.map((item) => (
              <li key={item.id}>{mediaName(item)}</li>
            ))}
          </ul>
          {inUse.length > 0 && (
            <>
              <p>
                其中 {inUse.length} 張還被頁面使用中，刪除後那些頁面就少一張圖：
              </p>
              <ul class="usage">
                {inUse.map((item) => (
                  <li key={item.id}>
                    {mediaName(item)} —{' '}
                    {(usage[item.id] ?? []).map((page) => page.title || page.path).join('、')}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ),
      confirmLabel: '刪除',
    })
    if (!agreed) return

    void run(async () => {
      const data = await apiJson<{ media: MediaItem[]; deleted: number; failed: string[] }>(
        `/api/media/delete${searchParam()}`,
        'POST',
        { ids, force: inUse.length > 0 },
      )
      setItems(data.media)
      setPicked([])
      if (selected && ids.includes(selected.id)) {
        setSelected(null)
        setUsedBy(null)
      }
      void loadTags()
      // What actually happened, which is not always what was asked for.
      if (data.failed.length > 0) return `刪除了 ${data.deleted} 張，有 ${data.failed.length} 張刪不掉，請再試一次。`
      if (data.deleted < ids.length) return `刪除了 ${data.deleted} 張，其餘的在別的地方已經刪掉了。`
    }, `已刪除 ${ids.length} 張圖。`)
  }

  const list =
    view === 'grid' ? (
      <MediaGrid
        items={shown}
        selectedId={selected?.id ?? null}
        onSelect={inspect}
        selection={{ chosen: new Set(picked), onToggle: togglePicked }}
      />
    ) : (
      <MediaTable
        items={shown}
        selectedId={selected?.id ?? null}
        onSelect={inspect}
        selection={{ chosen: new Set(picked), onToggle: togglePicked }}
      />
    )

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
          chooser without one, so it is hidden and the buttons in front of it
          open it. */}
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(event) => {
          const input = event.currentTarget as HTMLInputElement
          acceptFiles(input.files)
          // Cleared so that picking the same file twice in a row still
          // counts as a change.
          input.value = ''
        }}
        disabled={busy}
      />

      <section class="stack shop">
        <Panel title="媒體庫">
          <p class="muted">
            上傳一次，輪播、相簿與介紹區塊都能用。區塊記住的是這裡的圖片，不是網址，所以之後換掉檔名也不會斷。jpg、png
            或 webp，最大 5 MB。上傳時會在瀏覽器裡先做好三種寬度，手機不用下載整張原圖。
          </p>

          <section class="upload-area" aria-label="圖片上傳">
            <button
              type="button"
              class={dragging ? 'drop-zone drag-over' : 'drop-zone'}
              disabled={busy}
              onClick={() => file.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault()
                if (!busy) setDragging(true)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                if (!busy) setDragging(true)
              }}
              onDragLeave={(event) => {
                event.preventDefault()
                setDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                if (!busy) void acceptFiles(event.dataTransfer?.files ?? null)
              }}
            >
              <span class="drop-zone-icon" aria-hidden="true">
                ⇧
              </span>
              <span class="drop-zone-title">
                拖曳圖片至此
                <br />／點擊這裡選擇檔案即可上傳
              </span>
              <span class="drop-zone-hint">可以一次拖進好幾張，會一張一張上傳。</span>
            </button>

            {uploads.length > 0 && (
              <div class="upload-progress" aria-live="polite">
                {uploads.map((task) => (
                  <div key={task.key} class="media-upload-row">
                    <span class="upload-progress-label">
                      {task.name}
                      {task.state === 'failed' && <span class="media-upload-error">{task.error}</span>}
                    </span>
                    <div class="progress-track">
                      <div
                        class={task.state === 'failed' ? 'progress-bar failed' : 'progress-bar'}
                        style={{ width: `${Math.round((task.state === 'failed' ? 1 : task.ratio) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <MediaSearchField value={query} onChange={setQuery} />

          <div class="media-toolbar">
            <Checkbox
              label={pickedHere.length > 0 ? `已選 ${pickedHere.length} 張` : '全選'}
              checked={allPicked}
              disabled={shown.length === 0}
              onChange={togglePickedAll}
            />
            <Button
              tone="danger"
              size="sm"
              disabled={busy || pickedHere.length === 0}
              onClick={() => void removePicked()}
            >
              刪除選取
            </Button>
            <ButtonRow align="end">
              <Button
                tone={view === 'grid' ? 'primary' : 'ghost'}
                size="sm"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                格狀
              </Button>
              <Button
                tone={view === 'list' ? 'primary' : 'ghost'}
                size="sm"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                清單
              </Button>
            </ButtonRow>
          </div>

          {items === null ? (
            <Spinner />
          ) : shown.length === 0 && query.trim() ? (
            <EmptyState
              title="沒有符合的圖片"
              body="標籤要打完整才算命中，標題與檔名則是打一部分就好。"
              action={
                <Button tone="ghost" onClick={() => setQuery('')}>
                  清除搜尋
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState title="媒體庫還是空的" body="上傳第一張圖，之後在頁面的區塊裡就選得到它。" />
          ) : (
            list
          )}

          <Pagination
            info={info}
            unit="張"
            disabled={busy}
            onPage={(next) => {
              setPage(next)
              // Different pictures, so the ticks that were on the old ones are
              // not about anything any more.
              setPicked([])
            }}
          />
        </Panel>
      </section>

      {/* A dialog rather than a second card below the grid: the detail is
          about one picture, and a card left open beside a list you are still
          scrolling belongs to whichever image you last clicked, which is not
          always the one you are looking at. */}
      <Modal
        title={selected ? mediaName(selected) : ''}
        open={selected !== null}
        width="lg"
        onClose={() => {
          setSelected(null)
          setUsedBy(null)
          setUsageFailed(false)
        }}
        footer={
          <>
            <Button tone="ghost" onClick={() => setSelected(null)}>
              關閉
            </Button>
            <Button tone="danger" onClick={remove} disabled={busy || (usedBy === null && !usageFailed)}>
              刪除這張圖
            </Button>
          </>
        }
      >
        {selected && (
          <div class="media-detail">
            <div class="media-preview">
              <img
                src={apiUrl(selected.path)}
                srcset={srcSetFor(selected)}
                sizes="(max-width: 640px) 90vw, 420px"
                alt={selected.alt}
              />
            </div>

            {/* The facts, spelled out. Everything here was previously either
                missing or buried in a sentence, and they are what tells two
                versions of the same drawing apart. */}
            <dl class="media-facts">
              <div>
                <dt>檔名</dt>
                <dd>{selected.fileName}</dd>
              </div>
              <div>
                <dt>格式</dt>
                <dd>{mediaFormat(selected) || '未知'}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{fileSize(selected.byteSize)}</dd>
              </div>
              <div>
                <dt>尺寸</dt>
                <dd>{mediaDimensions(selected) || '未記錄'}</dd>
              </div>
              <div>
                <dt>上傳日期</dt>
                <dd>{dateOnly(selected.createdAt)}</dd>
              </div>
              <div>
                <dt>響應式寬度</dt>
                <dd>
                  {selected.sizes.length > 0
                    ? selected.sizes.map((size) => `${size.width}px`).join('、')
                    : '沒有（原圖已經夠小，或瀏覽器讀不到尺寸）'}
                </dd>
              </div>
            </dl>

            <p class="muted">
              <a href={apiUrl(selected.path)} target="_blank" rel="noopener">
                開啟原圖
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

            {/* Kept, and kept above the delete button. Naming the pages that
                use a picture before it goes is the thing this library does
                that the ones it was modelled on do not. */}
            <h3>用在哪裡</h3>
            {usedBy === null ? (
              <Spinner label="查詢中" />
            ) : usedBy.length === 0 ? (
              <EmptyState title="目前沒有頁面使用這張圖。" compact />
            ) : (
              <ul class="usage">
                {usedBy.map((page) => (
                  <li key={page.id}>
                    {page.title} <code>{page.path}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Modal>

      {dialog}
    </AdminShell>
  )
}
