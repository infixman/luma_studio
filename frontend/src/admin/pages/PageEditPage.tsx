import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import {
  AboutEditor,
  AlbumEditor,
  BLOCK_KINDS,
  CarouselEditor,
  ShopEditor,
  TextEditor,
  emptyConfig,
} from '../components/BlockEditors'
import type { Catalogue } from '../components/BlockEditors'
import { BlockPicker, BlockRow } from '../components/BlockRow'
import { useMediaPicker } from '../components/MediaPicker'
import { useStatus } from '../components/StatusBar'
import { Button, Panel, RadioGroup, Spinner, TextArea, TextField, Toggle, useConfirm } from '../components/ui'
import { Blocks } from '../../shared/components/Blocks'
import { ApiError, STOREFRONT_ORIGIN, api, apiJson, apiUrl, clearLoginAttempt } from '../../shared/api'
import type {
  AboutConfig,
  AlbumConfig,
  BlockConfig,
  CarouselConfig,
  MediaItem,
  PageBlock,
  PageDetail,
  PageStatus,
  ShopBlockConfig,
  TextBlockConfig,
} from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/pages-admin.css'
import '../styles/media-admin.css'

const STATUSES: { value: PageStatus; label: string; hint: string }[] = [
  { value: 'draft', label: '草稿', hint: '只有你看得到' },
  { value: 'published', label: '公開', hint: '任何人都能開啟這個網址' },
]

const KIND_LABEL = Object.fromEntries(BLOCK_KINDS.map((kind) => [kind.type, kind.label]))

const MAX_SHARE_DESCRIPTION = 200

/* The share image is held apart from the rest of the form because the editor
   only ever learns its URL, never the media id behind it. `id` stays null
   until the owner picks or clears one, and null is what tells the save to
   leave the stored image alone. */
interface ShareImage {
  id: string | null
  path: string | null
}

/* Widths, not device names dressed up as them: what changes the layout is
   how many pixels there are, and 390 is what a phone actually gives you. */
const VIEWPORTS = [
  { id: 'desktop', label: '桌機', width: '100%' },
  { id: 'tablet', label: '平板', width: '820px' },
  { id: 'mobile', label: '手機', width: '390px' },
] as const

type ViewportId = (typeof VIEWPORTS)[number]['id']

export function PageEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<PageDetail | null>(null)
  const [form, setForm] = useState({
    title: '',
    path: '',
    status: 'draft' as PageStatus,
    showHeader: true,
    showFooter: true,
    shareDescription: '',
  })
  const [shareImage, setShareImage] = useState<ShareImage>({ id: null, path: null })
  const [drafts, setDrafts] = useState<Record<string, BlockConfig>>({})
  const [library, setLibrary] = useState<MediaItem[]>([])
  const [catalogue, setCatalogue] = useState<Catalogue>({ products: [], categories: [] })
  /** Which block is expanded. One at a time: the point of collapsing is that the page stays short. */
  const [openId, setOpenId] = useState<string | null>(null)
  /** Where the type picker is open, as an index in the block list; null when closed. */
  const [inserting, setInserting] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const [viewport, setViewport] = useState<ViewportId>('desktop')
  /** The framed preview URL, or null while the block renderer is showing instead. */
  const [frame, setFrame] = useState<string | null>(null)
  const [framing, setFraming] = useState(false)
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()
  const picker = useMediaPicker()

  const byId = useMemo(() => new Map(library.map((item) => [item.id, item])), [library])

  const apply = useCallback((next: PageDetail) => {
    setDetail(next)
    setForm({
      title: next.page.title,
      path: next.page.path,
      status: next.page.status,
      showHeader: next.page.showHeader,
      showFooter: next.page.showFooter,
      shareDescription: next.page.shareDescription,
    })
    setShareImage({ id: null, path: next.page.shareImagePath })
    // Block configs are edited locally and saved on demand, so they are kept
    // beside the server's copy rather than derived from it on every render.
    setDrafts(Object.fromEntries(next.blocks.map((block) => [block.id, block.config])))
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await api<PageDetail>(`/api/pages/${encodeURIComponent(id)}`))
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [apply, id, showError])

  useEffect(() => {
    void load()
  }, [load])

  // The library and the catalogue are what the block editors offer to choose
  // from. Fetched once here rather than per block: five carousels on a page
  // would otherwise be five identical requests.
  useEffect(() => {
    api<{ media: MediaItem[] }>('/api/media')
      .then((data) => setLibrary(data.media))
      .catch(() => undefined)
    api<{ products: { slug: string; title: string }[] }>('/api/products')
      .then((data) => setCatalogue((current) => ({ ...current, products: data.products })))
      .catch(() => undefined)
    api<{ categories: { slug: string; title: string }[] }>('/api/categories')
      .then((data) => setCatalogue((current) => ({ ...current, categories: data.categories })))
      .catch(() => undefined)
  }, [])

  /** Picking may upload, so anything new has to join the local library. */
  const pick = useCallback(async () => {
    const item = await picker.request()
    if (item) setLibrary((current) => (current.some((entry) => entry.id === item.id) ? current : [item, ...current]))
    return item
  }, [picker])

  /**
   * Mints a fresh token and points the frame at it.
   *
   * A new one every time rather than a stored URL: the token is spent by the
   * load, so reusing it would show an expired page. That also means this is
   * the refresh button — there is nothing else to refresh with.
   */
  async function openLivePreview() {
    if (framing) return
    setFraming(true)
    try {
      const { token } = await apiJson<{ token: string }>(
        `/api/pages/${encodeURIComponent(id)}/preview-token`,
        'POST',
        {},
      )
      // Cache-busted because the browser will happily reuse the previous
      // frame for the same URL, and the URL is the only thing that changed.
      setFrame(`${STOREFRONT_ORIGIN}/__preview/${encodeURIComponent(token)}`)
    } catch (error) {
      showError(error)
    } finally {
      setFraming(false)
    }
  }

  /** Picking may upload, so this is the pick that also updates the preview. */
  async function chooseShareImage() {
    const item = await pick()
    if (item) setShareImage({ id: item.id, path: item.path })
  }

  async function run(work: () => Promise<PageDetail | void>, done: string) {
    if (busy) return
    setBusy(true)
    try {
      const next = await work()
      if (next) apply(next)
      show(done, 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** Which blocks hold edits the server has not seen. */
  function dirtyIds(current: PageDetail): string[] {
    return current.blocks
      .filter((block) => JSON.stringify(drafts[block.id] ?? block.config) !== JSON.stringify(block.config))
      .map((block) => block.id)
  }

  /**
   * One save for the whole page: the settings, then every block that changed.
   *
   * Each block used to carry its own save button, which meant one editing
   * session produced several writes and no single answer to "have I finished".
   * The API still takes them one at a time, so this walks them — but the
   * person editing presses one button and gets one answer.
   */
  function saveAll() {
    if (!detail) return
    const dirty = dirtyIds(detail)
    void run(async () => {
      // The image travels only when the owner touched it: leaving the field
      // out means "unchanged", so saving a title cannot drop a picture this
      // editor only ever knew as a URL.
      const body = shareImage.id === null ? form : { ...form, shareImageId: shareImage.id }
      await apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}`, 'PUT', body)
      let latest: PageDetail | undefined
      for (const blockId of dirty) {
        latest = await apiJson<PageDetail>(`/api/blocks/${encodeURIComponent(blockId)}`, 'PUT', {
          config: drafts[blockId],
        })
      }
      // The last write already answered with the whole page; only ask again
      // when there were no blocks to write.
      return latest ?? (await api<PageDetail>(`/api/pages/${encodeURIComponent(id)}`))
    }, dirty.length ? `已儲存，包含 ${dirty.length} 個區塊。` : '頁面已儲存。')
  }

  /** Adds at the end, then moves it into place — the API only appends. */
  function addBlock(type: PageBlock['type'], at: number) {
    setInserting(null)
    void run(async () => {
      const added = await apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks`, 'POST', {
        type,
        config: emptyConfig(type),
      })
      const fresh = added.blocks[added.blocks.length - 1]
      if (!fresh) return added
      setOpenId(fresh.id)
      if (at >= added.blocks.length - 1) return added

      const order = added.blocks.map((block) => block.id)
      order.splice(at, 0, ...order.splice(order.length - 1, 1))
      return apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks/order`, 'PUT', { ids: order })
    }, '區塊已新增。')
  }

  async function removeBlock(block: PageBlock) {
    const ok = await ask({
      title: '刪除區塊',
      body: (
        <p>
          確定要刪除這個「{KIND_LABEL[block.type] ?? block.type}」區塊嗎？裡面的設定會一起消失，而且無法復原。
        </p>
      ),
      confirmLabel: '刪除區塊',
    })
    if (!ok) return
    void run(() => api<PageDetail>(`/api/blocks/${encodeURIComponent(block.id)}`, { method: 'DELETE' }), '區塊已刪除。')
  }

  /** Commits a drag: the row that was picked up lands where it was dropped. */
  function dropBlock() {
    const move = drag
    setDrag(null)
    if (!detail || !move || move.from === move.over) return
    const order = detail.blocks.map((block) => block.id)
    order.splice(move.over, 0, ...order.splice(move.from, 1))
    void run(
      () => apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks/order`, 'PUT', { ids: order }),
      '順序已更新。',
    )
  }

  function edit(block: PageBlock, config: BlockConfig) {
    setDrafts((current) => ({ ...current, [block.id]: config }))
  }

  if (detail === null) {
    return (
      <AdminShell current="/pages" message={message} onError={showError}>
        <Spinner />
      </AdminShell>
    )
  }

  const viewportWidth = VIEWPORTS.find((size) => size.id === viewport)!.width
  const dirty = dirtyIds(detail)
  const pageChanged =
    form.title !== detail.page.title ||
    form.path !== detail.page.path ||
    form.status !== detail.page.status ||
    form.showHeader !== detail.page.showHeader ||
    form.showFooter !== detail.page.showFooter ||
    form.shareDescription !== detail.page.shareDescription ||
    shareImage.id !== null

  /**
   * What the storefront would render, given what is in the boxes right now.
   *
   * Pictures are resolved here from the library the editor already holds, so
   * a slide added a second ago appears without a round trip. Products are not:
   * prices and stock live on the server, so a shop block previews what it last
   * knew until the block is saved.
   */
  const previewBlocks: PageBlock[] = detail.blocks.map((block) => {
    const config = drafts[block.id] ?? block.config
    switch (block.type) {
      case 'carousel': {
        const draft = config as CarouselConfig
        return {
          ...block,
          config: draft,
          data: {
            slides: draft.slides
              .map((slide) => ({ item: byId.get(slide.mediaId), slide }))
              .filter((entry) => entry.item)
              .map(({ item, slide }) => ({
                image: { id: item!.id, path: item!.path, alt: item!.alt },
                caption: slide.caption,
                href: slide.href,
              })),
          },
        }
      }
      case 'album': {
        const draft = config as AlbumConfig
        return {
          ...block,
          config: draft,
          data: {
            images: draft.mediaIds
              .map((mediaId) => byId.get(mediaId))
              .filter((item): item is MediaItem => Boolean(item))
              .map((item) => ({ id: item.id, path: item.path, alt: item.alt })),
          },
        }
      }
      case 'about': {
        const draft = config as AboutConfig
        const item = draft.mediaId ? byId.get(draft.mediaId) : undefined
        return {
          ...block,
          config: draft,
          data: { image: item ? { id: item.id, path: item.path, alt: item.alt } : null },
        }
      }
      case 'shop':
        return { ...block, config: config as ShopBlockConfig }
      default:
        return { ...block, config: config as TextBlockConfig }
    }
  })

  const unsaved = pageChanged || dirty.length > 0

  return (
    <AdminShell
      current="/pages"
      title={detail.page.title}
      message={message}
      onError={showError}
      confirmLeave={() => !unsaved || confirm('有未儲存的修改，離開後會遺失。要繼續嗎？')}
      actions={
        <>
          {unsaved && <span class="unsaved-mark">有未儲存的修改</span>}
          <Button onClick={() => location.assign('/pages')}>回到頁面清單</Button>
          <Button tone="primary" busy={busy} disabled={!unsaved} onClick={saveAll}>
            儲存
          </Button>
        </>
      }
    >
      {dialog}

      <div class="page-editor">
        <div class="editor-main">
          <Panel title="區塊">
            {detail.blocks.length === 0 && inserting === null && (
              <p class="muted">還沒有區塊。用下面的按鈕加第一個。</p>
            )}

            <ul class="block-list">
              {detail.blocks.map((block, index) => (
                <>
                  {inserting === index && (
                    <li key={`picker-${index}`}>
                      <BlockPicker onPick={(type) => addBlock(type, index)} onCancel={() => setInserting(null)} />
                    </li>
                  )}
                  <BlockRow
                    key={block.id}
                    block={block}
                    config={drafts[block.id] ?? block.config}
                    open={openId === block.id}
                    dirty={dirty.includes(block.id)}
                    dragging={drag?.from === index}
                    onToggle={() => setOpenId(openId === block.id ? null : block.id)}
                    onDelete={() => void removeBlock(block)}
                    onInsert={(where) => setInserting(where === 'above' ? index : index + 1)}
                    onDragStart={() => setDrag({ from: index, over: index })}
                    onDragOver={() => setDrag((current) => (current ? { ...current, over: index } : null))}
                    onDrop={dropBlock}
                  >
                    {block.type === 'text' && (
                      <TextEditor
                        config={(drafts[block.id] ?? block.config) as TextBlockConfig}
                        onChange={(config) => edit(block, config)}
                      />
                    )}
                    {block.type === 'carousel' && (
                      <CarouselEditor
                        config={(drafts[block.id] ?? block.config) as CarouselConfig}
                        onChange={(config) => edit(block, config)}
                        library={byId}
                        pick={pick}
                      />
                    )}
                    {block.type === 'album' && (
                      <AlbumEditor
                        config={(drafts[block.id] ?? block.config) as AlbumConfig}
                        onChange={(config) => edit(block, config)}
                        library={byId}
                        pick={pick}
                      />
                    )}
                    {block.type === 'shop' && (
                      <ShopEditor
                        config={(drafts[block.id] ?? block.config) as ShopBlockConfig}
                        onChange={(config) => edit(block, config)}
                        catalogue={catalogue}
                      />
                    )}
                    {block.type === 'about' && (
                      <AboutEditor
                        config={(drafts[block.id] ?? block.config) as AboutConfig}
                        onChange={(config) => edit(block, config)}
                        library={byId}
                        pick={pick}
                      />
                    )}
                  </BlockRow>
                </>
              ))}
            </ul>

            {inserting === detail.blocks.length ? (
              <BlockPicker
                onPick={(type) => addBlock(type, detail.blocks.length)}
                onCancel={() => setInserting(null)}
              />
            ) : (
              <div class="add-block">
                <Button
                  disabled={busy}
                  onClick={() => setInserting(detail.blocks.length)}
                  icon={
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  }
                >
                  新增區塊
                </Button>
              </div>
            )}
          </Panel>

          <Panel
            title="預覽"
            actions={
              <>
                <div class="viewport-picker" role="group" aria-label="預覽寬度">
                  {VIEWPORTS.map((size) => (
                    <button
                      key={size.id}
                      type="button"
                      class={size.id === viewport ? 'current' : ''}
                      aria-pressed={size.id === viewport}
                      onClick={() => setViewport(size.id)}
                    >
                      {size.label}
                    </button>
                  ))}
                </div>
                <Button size="sm" busy={framing} onClick={() => void openLivePreview()}>
                  {frame ? '重新整理' : '看真實畫面'}
                </Button>
              </>
            }
          >
            {frame ? (
              <>
                {/* The real storefront, on its own host, wearing its own
                    header and footer. Sandboxed to scripts and same-origin —
                    it needs both to render, and nothing else. */}
                <div class="live-frame" style={{ maxWidth: viewportWidth }}>
                  <iframe
                    src={frame}
                    title="頁面預覽"
                    sandbox="allow-scripts allow-same-origin"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <p class="muted">
                  這是真的前台，連結只能用一次、十分鐘後失效。未儲存的修改不會出現在這裡——它讀的是伺服器上的版本。
                </p>
              </>
            ) : (
              <>
                <div class="preview-surface" style={{ maxWidth: viewportWidth }}>
                  {previewBlocks.length === 0 ? <p class="muted">還沒有內容。</p> : <Blocks blocks={previewBlocks} />}
                </div>
                <p class="muted">
                  這裡用的是前台渲染區塊的同一份程式，所以區塊本身就是公開後的樣子——但沒有站台的頁首頁尾與底色。要看整頁，按「看真實畫面」。
                </p>
              </>
            )}
          </Panel>
        </div>

        {/* The settings sit beside the blocks rather than above them: they are
            changed once and then read, while the blocks are the work. */}
        <aside class="editor-side">
          <Panel title="頁面設定">
            <TextField
              label="頁面名稱"
              value={form.title}
              onInput={(event) => setForm({ ...form, title: (event.currentTarget as HTMLInputElement).value })}
              maxLength={80}
              required
              hint="會成為瀏覽器分頁的標題。"
            />
            <TextField
              label="網址路徑"
              value={form.path}
              onInput={(event) => setForm({ ...form, path: (event.currentTarget as HTMLInputElement).value })}
              maxLength={120}
              required
              disabled={detail.page.isHome}
              hint={
                detail.page.isHome
                  ? '這一頁是首頁，網址固定是 /。取消首頁後才能改路徑。'
                  : '例如 /about。/shop、/cart 這類系統路徑不能使用。'
              }
            />
            <RadioGroup
              legend="狀態"
              value={form.status}
              options={STATUSES.map((status) => ({ value: status.value, label: status.label, hint: status.hint }))}
              onChange={(status) => setForm({ ...form, status })}
            />
            <Toggle
              label="顯示網站頁首"
              checked={form.showHeader}
              onChange={(showHeader) => setForm({ ...form, showHeader })}
            />
            <Toggle
              label="顯示網站頁尾"
              checked={form.showFooter}
              onChange={(showFooter) => setForm({ ...form, showFooter })}
              // Both on unless this page is the exception — a landing page
              // that wants nothing but its own content.
              hint="關掉之後，這一頁就只有區塊，沒有選單也沒有頁尾連結。"
            />
          </Panel>

          <Panel title="分享預覽">
            <p class="muted">有人把這一頁貼到 LINE 或 Facebook 時看到的卡片。標題用的是上面的頁面名稱。</p>

            <TextArea
              label="分享文案"
              hint={`${form.shareDescription.length} / ${MAX_SHARE_DESCRIPTION} 字，建議 70–120 字：太短說不完，太長會被截掉。`}
              rows={3}
              maxLength={MAX_SHARE_DESCRIPTION}
              value={form.shareDescription}
              onInput={(event) =>
                setForm({ ...form, shareDescription: (event.currentTarget as HTMLTextAreaElement).value })
              }
            />

            <div class="portrait-row">
              {shareImage.path ? (
                <img class="thumb" src={apiUrl(shareImage.path)} alt="" />
              ) : (
                <span class="thumb empty">沒有圖片</span>
              )}
              <div class="controls">
                <Button size="sm" onClick={() => void chooseShareImage()}>
                  {shareImage.path ? '換圖片' : '選一張圖片'}
                </Button>
                {shareImage.path && (
                  <Button size="sm" tone="danger" onClick={() => setShareImage({ id: '', path: null })}>
                    移除
                  </Button>
                )}
              </div>
            </div>

            {/* Nothing here is required: a page with an empty panel still
                shares as itself, just with the site's own card. */}
            <p class="muted">沒有選就用網站預設的分享圖。</p>
          </Panel>
        </aside>
      </div>

      {picker.element}
    </AdminShell>
  )
}
