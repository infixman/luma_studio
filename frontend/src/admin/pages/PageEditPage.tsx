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
import { Button, Panel, RadioGroup, Spinner, TextField, Toggle, useConfirm } from '../components/ui'
import { Blocks } from '../../shared/components/Blocks'
import { ApiError, api, apiJson, clearLoginAttempt } from '../../shared/api'
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

export function PageEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<PageDetail | null>(null)
  const [form, setForm] = useState({ title: '', path: '', status: 'draft' as PageStatus, showHeader: true, showFooter: true })
  const [drafts, setDrafts] = useState<Record<string, BlockConfig>>({})
  const [library, setLibrary] = useState<MediaItem[]>([])
  const [catalogue, setCatalogue] = useState<Catalogue>({ products: [], categories: [] })
  /** Which block is expanded. One at a time: the point of collapsing is that the page stays short. */
  const [openId, setOpenId] = useState<string | null>(null)
  /** Where the type picker is open, as an index in the block list; null when closed. */
  const [inserting, setInserting] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
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
    })
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
      await apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}`, 'PUT', form)
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

  const dirty = dirtyIds(detail)
  const pageChanged =
    form.title !== detail.page.title ||
    form.path !== detail.page.path ||
    form.status !== detail.page.status ||
    form.showHeader !== detail.page.showHeader ||
    form.showFooter !== detail.page.showFooter

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

          <Panel title="預覽">
            <p class="muted">
              這裡用的是前台渲染區塊的同一份程式，所以看到的就是公開後的樣子。商城區塊的商品要儲存後才會更新。
            </p>
            <div class="preview-surface">
              {previewBlocks.length === 0 ? <p class="muted">還沒有內容。</p> : <Blocks blocks={previewBlocks} />}
            </div>
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
        </aside>
      </div>

      {picker.element}
    </AdminShell>
  )
}
