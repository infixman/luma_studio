import { Fragment } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { AdminShell } from '../../components/AdminShell'
import {
  AboutEditor,
  AlbumEditor,
  BLOCK_KINDS,
  CarouselEditor,
  ContactEditor,
  ShopEditor,
  TextEditor,
  emptyConfig,
} from './blocks/BlockEditor'
import type { Catalogue } from './blocks/BlockEditor'
import { BlockPicker, BlockRow } from './components/BlockRow'
import { useMediaPicker } from '../../components/MediaPicker'
import { PublishPanel } from '../../components/PublishPanel'
import { SlugLock } from '../../components/SlugLock'
import { useStatus } from '../../components/StatusBar'
import {
  Button,
  EmptyState,
  Panel,
  Spinner,
  TextArea,
  TextField,
  Toggle,
  useConfirm,
} from '../../components/ui'
import { CLIPBOARD_KEY, readCopiedBlock, writeCopiedBlock } from '../../lib/blockClipboard'
import type { CopiedBlock } from '../../lib/blockClipboard'
import { followsTitle, nextPath } from '../../lib/slug'
import { Blocks } from '../../../shared/components/Blocks'
import { dateTime } from '../../../shared/dates'
import { api, apiJson, apiUrl } from '../../../shared/api'
import type {
  AboutConfig,
  AlbumConfig,
  BlockConfig,
  CarouselConfig,
  ContactConfig,
  MediaItem,
  PageBlock,
  PageDetail,
  PageVersion,
  ShopBlockConfig,
  TextBlockConfig,
} from '../../../shared/types'
import { PAGE_PATH_MAX, PAGE_TITLE_MAX } from './constraints'
import { projectDraftBlocks } from './preview/projectDraftBlocks'
import { useLivePagePreview } from './hooks/useLivePagePreview'
import '../../styles/pages-admin.css'
import '../../styles/media-admin.css'

const KIND_LABEL = Object.fromEntries(BLOCK_KINDS.map((kind) => [kind.type, kind.label]))

/* The types this build can edit and draw. A paste is checked against it, so a
   block copied from a newer deployment is refused rather than dropped into a
   page that has no editor for it. */
const KNOWN_TYPES = BLOCK_KINDS.map((kind) => kind.type)

/** The anchor a row gets, so a click in the preview has somewhere to scroll to. */
const rowId = (blockId: string) => `block-row-${blockId}`

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

/**
 * A library item as a block wants it.
 *
 * The widths travel too, so the editor's own preview asks for the same file
 * the storefront would. Without them the preview would quietly be the only
 * place that always loads the full-size original.
 */
export function PageEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<PageDetail | null>(null)
  const [form, setForm] = useState({
    title: '',
    path: '',
    showHeader: true,
    showFooter: true,
    shareDescription: '',
  })
  const [shareImage, setShareImage] = useState<ShareImage>({ id: null, path: null })
  const [drafts, setDrafts] = useState<Record<string, BlockConfig>>({})
  const [library, setLibrary] = useState<MediaItem[]>([])
  const [catalogue, setCatalogue] = useState<Catalogue>({ products: [], categories: [] })
  /**
   * Which blocks are expanded, and whether opening one closes the rest.
   *
   * One at a time is the default, because the point of collapsing is that the
   * page stays short enough to scan. 全部展開 is the override — comparing two
   * carousels, or reading the whole page in one pass, needs them all open —
   * and it flips `multi` so that opening a sixth does not close the five you
   * just asked for.
   */
  const [openIds, setOpenIds] = useState<string[]>([])
  const [multi, setMulti] = useState(false)
  /** What is on the block clipboard right now, or null if it is empty or unusable. */
  const [clipboard, setClipboard] = useState<CopiedBlock | null>(null)
  /** Shut while the path is the title's shadow; opened by the owner to type their own. */
  const [pathLocked, setPathLocked] = useState(false)
  /** Where the type picker is open, as an index in the block list; null when closed. */
  const [inserting, setInserting] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const [viewport, setViewport] = useState<ViewportId>('desktop')
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
  const { frame, framing, openLivePreview } = useLivePagePreview(id, showError)
  const { ask, dialog } = useConfirm()
  const picker = useMediaPicker()

  const byId = useMemo(() => new Map(library.map((item) => [item.id, item])), [library])

  /**
   * Take the server's answer, without throwing away work in progress.
   *
   * `keepDrafts` is the whole point. Every mutation answers with the full page
   * — adding a block, reordering, deleting one — and this used to overwrite
   * the local drafts each time. So dragging a block would silently revert
   * unsaved edits in every other block, and duplicating a block you had just
   * edited put your text on the copy and reverted the original.
   *
   * Only a load and a save are entitled to replace what is on screen: those
   * are the two moments the server's copy IS the truth.
   */
  const apply = useCallback((next: PageDetail, keepDrafts = false) => {
    setDetail(next)
    setForm({
      title: next.page.title,
      path: next.page.path,
      showHeader: next.page.showHeader,
      showFooter: next.page.showFooter,
      shareDescription: next.page.shareDescription,
    })
    setShareImage({ id: null, path: next.page.shareImagePath })
    setDrafts((current) =>
      Object.fromEntries(
        next.blocks.map((block) => [block.id, keepDrafts ? current[block.id] ?? block.config : block.config]),
      ),
    )
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await api<PageDetail>(`/api/pages/${encodeURIComponent(id)}`)
      apply(next)
      // Where the lock starts, decided once from what is already stored: a
      // path that still matches its title is one nobody has taken over, so it
      // can go on following. A path that was typed by hand cannot, or the
      // first keystroke in the title box would move a published address.
      setPathLocked(followsTitle(next.page.title, next.page.path))
    } catch (error) {
      showError(error)
    }
  }, [apply, id, showError])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The browser asks before the work is lost.
   *
   * 「有未儲存的修改」 in the title bar is passive, and every way out of this
   * page — the rail, the sidebar, 回到頁面清單 — is an ordinary link. Without
   * this, three edited blocks vanish on one misplaced click, silently.
   */
  useEffect(() => {
    if (!unsaved) return
    const ask = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  })

  /* The clipboard is a place, not a message, so it is read rather than
     received. Re-read on focus and on the storage event because the copy that
     fills it usually happens in the other tab, or on the page you just came
     from — and a menu offering 貼上區塊 has to know before it is opened. */
  useEffect(() => {
    const refresh = () => setClipboard(readCopiedBlock(KNOWN_TYPES))
    refresh()
    const moved = (event: StorageEvent) => {
      if (event.key === null || event.key === CLIPBOARD_KEY) refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('storage', moved)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('storage', moved)
    }
  }, [])

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

  /** Picking may upload, so this is the pick that also updates the preview. */
  async function chooseShareImage() {
    const item = await pick()
    if (item) setShareImage({ id: item.id, path: item.path })
  }

  /** Answers whether the work went through, which is what "and then refresh the frame" needs to know. */
  /**
   * `keepDrafts` defaults to true because most of what goes through here is a
   * structural change — add, delete, reorder — and none of those are a reason
   * to discard text somebody is in the middle of typing. Saving passes false.
   */
  async function run(
    work: () => Promise<PageDetail | void>,
    done: string,
    { keepDrafts = true }: { keepDrafts?: boolean } = {},
  ): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    try {
      const next = await work()
      if (next) apply(next, keepDrafts)
      show(done, 'ok')
      return true
    } catch (error) {
      showError(error)
      return false
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
    const refreshFrame = frame !== null
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
    }, dirty.length ? `已儲存，包含 ${dirty.length} 個區塊。` : '頁面已儲存。', { keepDrafts: false }).then((ok) => {
      // The frame reads the server, so what it is showing is now one save out
      // of date. Refreshing it means minting another token, because the one
      // that loaded it was spent by that load — reusing the URL would put an
      // expired page where the preview was.
      if (ok && refreshFrame) void openLivePreview()
    })
  }

  function publishPage() {
    void run(
      () => apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/publish`, 'POST', {}),
      '已發布。網站上現在就是這一份。',
    )
  }

  async function unpublishPage() {
    const agreed = await ask({
      title: '取消發布這一頁？',
      body: '網址會變成 404，內容留著。發布紀錄不會刪掉，之後可以再發布回去。',
      confirmLabel: '取消發布',
    })
    if (!agreed) return
    void run(
      () => apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/unpublish`, 'POST', {}),
      '已從網站上撤下。',
    )
  }

  /**
   * Put an old version back into the draft.
   *
   * It asks the server what that version points at that is gone before
   * drawing the dialog. Everywhere else a missing image just drops its slide
   * quietly, and that is right — but a restore is a deliberate look backwards,
   * and coming back one product short without warning reads as a failed
   * restore rather than as a product that was archived in the meantime.
   */
  async function restoreVersion(version: PageVersion) {
    let missing: { images: string[]; products: string[] } = { images: [], products: [] }
    try {
      const answer = await api<{ missing: typeof missing }>(
        `/api/pages/${encodeURIComponent(id)}/versions/${encodeURIComponent(version.id)}`,
      )
      missing = answer.missing
    } catch (error) {
      // Not being able to check is not a reason to refuse. The dialog simply
      // stops making a promise it cannot keep.
      showError(error)
    }
    const gone = missing.images.length + missing.products.length

    const agreed = await ask({
      title: `還原到 ${dateTime(version.publishedAt)} 的版本？`,
      body: (
        <>
          <p>這一版會覆蓋目前的草稿，但不會直接上線——看過之後再按發布。</p>
          {gone > 0 && (
            <>
              <p>
                這一版點名的東西有 {gone} 個已經不在了，還原後那些位置會是空的：
              </p>
              <ul class="usage">
                {missing.products.map((slug) => (
                  <li key={`p-${slug}`}>商品 {slug}</li>
                ))}
                {missing.images.map((mediaId) => (
                  <li key={`i-${mediaId}`}>圖片 {mediaId}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ),
      confirmLabel: '還原',
      tone: gone > 0 ? 'danger' : 'primary',
    })
    if (!agreed) return
    void run(
      () =>
        apiJson<PageDetail>(
          `/api/pages/${encodeURIComponent(id)}/versions/${encodeURIComponent(version.id)}`,
          'POST',
          {},
        ),
      '已還原成那一版的內容。看過之後再發布。',
      { keepDrafts: false },
    )
  }

  /** Expands a block, closing the others unless the owner asked for all of them. */
  function openBlock(blockId: string) {
    setOpenIds((current) => (multi ? [...current.filter((each) => each !== blockId), blockId] : [blockId]))
  }

  function toggleBlock(blockId: string) {
    setOpenIds((current) =>
      current.includes(blockId) ? current.filter((each) => each !== blockId) : multi ? [...current, blockId] : [blockId],
    )
  }

  /**
   * Opens a block and brings its row into view.
   *
   * Called from the preview, which is why this exists at all: the preview and
   * the editor are in the same document, so a click on a rendered block can
   * reach the row that made it without a single message crossing a frame.
   * The scroll waits a frame because the row is about to grow.
   */
  function focusBlock(blockId: string) {
    openBlock(blockId)
    requestAnimationFrame(() => {
      document.getElementById(rowId(blockId))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  /**
   * Puts a block at a given index. Adds at the end, then moves it into
   * place — the API only appends.
   *
   * `config` is what the new block starts as: an empty one when it came from
   * the picker, a copy of another when it came from 複製 or 貼上區塊.
   */
  function insertBlock(type: PageBlock['type'], config: BlockConfig, at: number, done: string) {
    setInserting(null)
    void run(async () => {
      const added = await apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks`, 'POST', {
        type,
        config,
      })
      const fresh = added.blocks[added.blocks.length - 1]
      if (!fresh) return added
      openBlock(fresh.id)
      if (at >= added.blocks.length - 1) return added

      const order = added.blocks.map((block) => block.id)
      order.splice(at, 0, ...order.splice(order.length - 1, 1))
      return apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks/order`, 'PUT', { ids: order })
    }, done)
  }

  function addBlock(type: PageBlock['type'], at: number) {
    insertBlock(type, emptyConfig(type), at, '區塊已新增。')
  }

  /* The config that goes on the clipboard, or into the twin, is the one on
     screen — not the one the server last saw. Copying a block you have just
     finished editing has to copy those edits, or the gesture is a trap. */
  const configOf = (block: PageBlock): BlockConfig => drafts[block.id] ?? block.config

  function duplicateBlock(block: PageBlock, index: number) {
    insertBlock(block.type, configOf(block), index + 1, '區塊已複製。')
  }

  function copyBlock(block: PageBlock) {
    const copied: CopiedBlock = { type: block.type, config: configOf(block) }
    if (!writeCopiedBlock(copied)) {
      show('這個瀏覽器不讓我們暫存區塊，複製失敗。', 'error')
      return
    }
    setClipboard(copied)
    show('已複製，可以貼到任何一頁。', 'ok')
  }

  function pasteBlock(index: number) {
    if (!clipboard) return
    insertBlock(clipboard.type, clipboard.config, index + 1, '區塊已貼上。')
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

  /* The two overrides. 全部展開 also switches the list into multi mode, or
     opening a sixth block would close the five that were just asked for;
     全部收合 switches it back, which is the editor's default. */
  const expandAll = () => {
    setMulti(true)
    setOpenIds(detail.blocks.map((block) => block.id))
  }
  const collapseAll = () => {
    setMulti(false)
    setOpenIds([])
  }

  const dirty = dirtyIds(detail)
  const pageChanged =
    form.title !== detail.page.title ||
    form.path !== detail.page.path ||
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
   *
   * That library stops at the most recent 300 images, so an id can fail to
   * resolve here and still be perfectly fine — which is why every case falls
   * back to what the server already hydrated. Without that, opening an older
   * page in a shop with 400 pictures previewed an empty carousel and blank
   * album tiles, while the published page rendered correctly. Showing somebody
   * convincing evidence that their images are gone is worse than showing them
   * a slightly stale one.
   */
  const previewBlocks: PageBlock[] = projectDraftBlocks(detail.blocks, drafts, byId)

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
          <Panel
            title="區塊"
            actions={
              detail.blocks.length > 1 && (
                <>
                  <Button size="sm" onClick={collapseAll}>
                    全部收合
                  </Button>
                  <Button size="sm" onClick={expandAll}>
                    全部展開
                  </Button>
                </>
              )
            }
          >
            {detail.blocks.length === 0 && inserting === null && (
              <EmptyState title="還沒有區塊" body="用下面的按鈕加第一個。" />
            )}

            <ul class="block-list">
              {detail.blocks.map((block, index) => (
                // Keyed on the block, not the index: the picker appearing
                // between two rows must not make Preact believe every row
                // below it is a different block.
                <Fragment key={block.id}>
                  {inserting === index && (
                    <li>
                      <BlockPicker onPick={(type) => addBlock(type, index)} onCancel={() => setInserting(null)} />
                    </li>
                  )}
                  <BlockRow
                    key={block.id}
                    block={block}
                    config={drafts[block.id] ?? block.config}
                    position={index + 1}
                    domId={rowId(block.id)}
                    open={openIds.includes(block.id)}
                    dirty={dirty.includes(block.id)}
                    dragging={drag?.from === index}
                    onToggle={() => toggleBlock(block.id)}
                    onDelete={() => void removeBlock(block)}
                    onInsert={(where) => setInserting(where === 'above' ? index : index + 1)}
                    onDuplicate={() => duplicateBlock(block, index)}
                    onCopy={() => copyBlock(block)}
                    onPaste={clipboard ? () => pasteBlock(index) : null}
                    onDragStart={() => setDrag({ from: index, over: index })}
                    onDragOver={() => setDrag((current) => (current ? { ...current, over: index } : null))}
                    onDrop={dropBlock}
                    onDragEnd={() => setDrag(null)}
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
                    {block.type === 'contact' && (
                      <ContactEditor
                        config={(drafts[block.id] ?? block.config) as ContactConfig}
                        onChange={(config) => edit(block, config)}
                        library={byId}
                        pick={pick}
                      />
                    )}
                  </BlockRow>
                </Fragment>
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
                  {previewBlocks.length === 0 ? (
                    <EmptyState title="還沒有內容。" compact />
                  ) : (
                    /* One <Blocks> per block rather than one for the list, so
                       each rendered block sits in something that knows which
                       row made it. Payload posts a message into an iframe for
                       this; ours is the same document, so the click is just a
                       click. */
                    previewBlocks.map((block) => (
                      <div
                        key={block.id}
                        class={openIds.includes(block.id) ? 'preview-block is-open' : 'preview-block'}
                        onClick={(event) => {
                          // A carousel arrow and an album's lightbox are inside
                          // here. Stealing those clicks would break the preview
                          // to make it navigable, which is the wrong trade.
                          if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return
                          focusBlock(block.id)
                        }}
                      >
                        <Blocks blocks={[block]} />
                        {/* The keyboard's way in. The wrapper cannot be the
                            button — it has buttons inside it. */}
                        <button
                          type="button"
                          class="preview-jump"
                          onClick={() => focusBlock(block.id)}
                        >
                          編輯這個區塊
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <p class="muted">
                  這裡用的是前台渲染區塊的同一份程式，所以區塊本身就是公開後的樣子——但沒有站台的頁首頁尾與底色。點一下就會打開那個區塊的編輯器。要看整頁，按「看真實畫面」。
                </p>
              </>
            )}
          </Panel>
        </div>

        {/* The settings sit beside the blocks rather than above them: they are
            changed once and then read, while the blocks are the work. */}
        <aside class="editor-side">
          <PublishPanel
            state={detail.publishState}
            versions={detail.versions}
            busy={busy}
            unsaved={unsaved}
            hasBlocks={detail.blocks.length > 0}
            onPublish={publishPage}
            onUnpublish={unpublishPage}
            onRestore={restoreVersion}
          />

          <Panel title="頁面設定">
            <TextField
              label="頁面名稱"
              value={form.title}
              onInput={(event) => {
                const title = (event.currentTarget as HTMLInputElement).value
                // The path comes along while the lock is shut. The home page
                // is excluded outright: its address is / whatever it is called.
                setForm((current) => ({
                  ...current,
                  title,
                  path: nextPath(current.path, title, pathLocked && !detail.page.isHome),
                }))
              }}
              maxLength={PAGE_TITLE_MAX}
              required
              hint="會成為瀏覽器分頁的標題。"
            />
            <TextField
              label="網址路徑"
              value={form.path}
              onInput={(event) => setForm({ ...form, path: (event.currentTarget as HTMLInputElement).value })}
              maxLength={PAGE_PATH_MAX}
              required
              disabled={detail.page.isHome || pathLocked}
              trailing={!detail.page.isHome && <SlugLock locked={pathLocked} onChange={setPathLocked} />}
              hint={
                detail.page.isHome
                  ? '這一頁是首頁，網址固定是 /。取消首頁後才能改路徑。'
                  : pathLocked
                    ? '跟著頁面名稱走。要自己填的話，按右邊的鎖。'
                    : '例如 /about。/shop、/cart 這類系統路徑不能使用。'
              }
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
