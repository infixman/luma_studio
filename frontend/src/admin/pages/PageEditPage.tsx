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
import { useMediaPicker } from '../components/MediaPicker'
import { useStatus } from '../components/StatusBar'
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
  const [adding, setAdding] = useState<PageBlock['type']>('text')
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
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

  function savePage(event: Event) {
    event.preventDefault()
    void run(() => apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}`, 'PUT', form), '頁面已儲存。')
  }

  function addBlock() {
    void run(
      () =>
        apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks`, 'POST', {
          type: adding,
          config: emptyConfig(adding),
        }),
      '區塊已新增。',
    )
  }

  function saveBlock(block: PageBlock) {
    void run(
      () =>
        apiJson<PageDetail>(`/api/blocks/${encodeURIComponent(block.id)}`, 'PUT', {
          config: drafts[block.id] ?? block.config,
        }),
      '區塊已儲存。',
    )
  }

  function removeBlock(block: PageBlock) {
    if (!confirm('確定要刪除這個區塊？')) return
    void run(() => api<PageDetail>(`/api/blocks/${encodeURIComponent(block.id)}`, { method: 'DELETE' }), '區塊已刪除。')
  }

  function move(block: PageBlock, by: number) {
    if (!detail) return
    const order = detail.blocks.map((entry) => entry.id)
    const from = order.indexOf(block.id)
    const to = from + by
    if (to < 0 || to >= order.length) return
    order.splice(to, 0, ...order.splice(from, 1))
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
        <section class="stack shop">
          <div class="card">
            <p class="muted">載入中…</p>
          </div>
        </section>
      </AdminShell>
    )
  }

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

  return (
    <AdminShell current="/pages" message={message} onError={showError}>
      <section class="stack shop">
        <p class="crumb">
          <a href="/pages">← 回到頁面</a>
        </p>
        <h2 class="product-heading">{detail.page.title}</h2>

        <div class="card">
          <h3>頁面設定</h3>
          <form class="product-form" onSubmit={savePage}>
            <label>
              頁面名稱
              <input
                value={form.title}
                onInput={(event) => setForm({ ...form, title: (event.target as HTMLInputElement).value })}
                maxLength={80}
                required
              />
              <small>會成為瀏覽器分頁的標題。</small>
            </label>
            <label>
              網址路徑
              <input
                value={form.path}
                onInput={(event) => setForm({ ...form, path: (event.target as HTMLInputElement).value })}
                maxLength={120}
                required
                disabled={detail.page.isHome}
              />
              <small>
                {detail.page.isHome
                  ? '這一頁是首頁，網址固定是 /。取消首頁後才能改路徑。'
                  : '例如 /about。/shop、/cart 這類系統路徑不能使用。'}
              </small>
            </label>
            <fieldset class="statuses">
              <legend>狀態</legend>
              {STATUSES.map((status) => (
                <label key={status.value} class="radio">
                  <input
                    type="radio"
                    name="status"
                    checked={form.status === status.value}
                    onChange={() => setForm({ ...form, status: status.value })}
                  />
                  <span>
                    {status.label}
                    <small>{status.hint}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label class="toggle">
              <input
                type="checkbox"
                checked={form.showHeader}
                onChange={(event) => setForm({ ...form, showHeader: (event.target as HTMLInputElement).checked })}
              />
              顯示網站頁首
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={form.showFooter}
                onChange={(event) => setForm({ ...form, showFooter: (event.target as HTMLInputElement).checked })}
              />
              顯示網站頁尾
            </label>
            {/* Both on unless this page is the exception — a landing page that
                wants nothing but its own content. */}
            <p class="muted">關掉之後，這一頁就只有下面的區塊，沒有選單也沒有頁尾連結。</p>

            <button type="submit" disabled={busy}>
              儲存頁面
            </button>
          </form>
        </div>

        <div class="editor-split">
          <div class="card blocks">
            <h3>區塊</h3>
            {detail.blocks.length === 0 && <p class="muted">還沒有區塊。從下面挑一種加上去。</p>}

            <ul class="block-list">
              {detail.blocks.map((block, index) => (
                <li key={block.id}>
                  <div class="block-head">
                    <span class="kind">{KIND_LABEL[block.type] ?? block.type}</span>
                    <button type="button" disabled={busy || index === 0} onClick={() => move(block, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={busy || index === detail.blocks.length - 1}
                      onClick={() => move(block, 1)}
                    >
                      ↓
                    </button>
                    <button type="button" class="danger" onClick={() => removeBlock(block)}>
                      刪除
                    </button>
                  </div>

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

                  <button type="button" disabled={busy} onClick={() => saveBlock(block)}>
                    儲存這個區塊
                  </button>
                </li>
              ))}
            </ul>

            <div class="add-block">
              <select value={adding} onChange={(event) => setAdding((event.target as HTMLSelectElement).value as PageBlock['type'])}>
                {BLOCK_KINDS.map((kind) => (
                  <option key={kind.type} value={kind.type}>
                    {kind.label}
                  </option>
                ))}
              </select>
              <button type="button" disabled={busy} onClick={addBlock}>
                新增區塊
              </button>
              <small class="muted">{BLOCK_KINDS.find((kind) => kind.type === adding)?.hint}</small>
            </div>
          </div>

          <div class="card preview">
            <h3>預覽</h3>
            <p class="muted">
              這裡用的是前台渲染區塊的同一份程式，所以看到的就是公開後的樣子。商城區塊的商品要儲存後才會更新。
            </p>
            <div class="preview-surface">
              {previewBlocks.length === 0 ? <p class="muted">還沒有內容。</p> : <Blocks blocks={previewBlocks} />}
            </div>
          </div>
        </div>
      </section>

      {picker.element}
    </AdminShell>
  )
}
