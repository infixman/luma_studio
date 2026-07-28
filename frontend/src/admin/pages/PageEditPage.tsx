import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Blocks } from '../../shared/components/Blocks'
import { ApiError, api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { PageBlock, PageDetail, PageStatus } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/pages-admin.css'

const STATUSES: { value: PageStatus; label: string; hint: string }[] = [
  { value: 'draft', label: '草稿', hint: '只有你看得到' },
  { value: 'published', label: '公開', hint: '任何人都能開啟這個網址' },
]

export function PageEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<PageDetail | null>(null)
  const [form, setForm] = useState({ title: '', path: '', status: 'draft' as PageStatus })
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const apply = useCallback((next: PageDetail) => {
    setDetail(next)
    setForm({ title: next.page.title, path: next.page.path, status: next.page.status })
    // The textareas are edited locally and saved on demand, so their state is
    // kept beside the server's rather than derived from it on every render.
    setBodies(Object.fromEntries(next.blocks.map((block) => [block.id, block.config.body ?? ''])))
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
      () => apiJson<PageDetail>(`/api/pages/${encodeURIComponent(id)}/blocks`, 'POST', { type: 'text', config: { body: '' } }),
      '區塊已新增。',
    )
  }

  function saveBlock(block: PageBlock) {
    void run(
      () => apiJson<PageDetail>(`/api/blocks/${encodeURIComponent(block.id)}`, 'PUT', { config: { body: bodies[block.id] ?? '' } }),
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

  // What the storefront would render, given what is in the boxes right now.
  const previewBlocks: PageBlock[] = detail.blocks.map((block) => ({
    ...block,
    config: { body: bodies[block.id] ?? '' },
  }))

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
            <button type="submit" disabled={busy}>
              儲存頁面
            </button>
          </form>
        </div>

        <div class="editor-split">
          <div class="card blocks">
            <h3>區塊</h3>
            {detail.blocks.length === 0 && <p class="muted">還沒有區塊。加一個文字區塊開始。</p>}

            <ul class="block-list">
              {detail.blocks.map((block, index) => (
                <li key={block.id}>
                  <div class="block-head">
                    <span class="kind">文字</span>
                    <button type="button" disabled={busy || index === 0} onClick={() => move(block, -1)}>
                      ↑
                    </button>
                    <button type="button" disabled={busy || index === detail.blocks.length - 1} onClick={() => move(block, 1)}>
                      ↓
                    </button>
                    <button type="button" class="danger" onClick={() => removeBlock(block)}>
                      刪除
                    </button>
                  </div>
                  <textarea
                    rows={10}
                    maxLength={20000}
                    value={bodies[block.id] ?? ''}
                    placeholder={'# 標題\n\n一段文字。\n\n- 清單項目\n- 另一項\n\n**粗體**、[連結](https://example.com)'}
                    onInput={(event) =>
                      setBodies({ ...bodies, [block.id]: (event.target as HTMLTextAreaElement).value })
                    }
                  />
                  <button type="button" disabled={busy} onClick={() => saveBlock(block)}>
                    儲存這個區塊
                  </button>
                </li>
              ))}
            </ul>

            <button type="button" disabled={busy} onClick={addBlock}>
              新增文字區塊
            </button>
          </div>

          <div class="card preview">
            <h3>預覽</h3>
            <p class="muted">
              這裡用的是前台渲染區塊的同一份程式，所以看到的就是公開後的樣子。
            </p>
            <div class="preview-surface">
              {previewBlocks.length === 0 ? <p class="muted">還沒有內容。</p> : <Blocks blocks={previewBlocks} />}
            </div>
          </div>
        </div>
      </section>
    </AdminShell>
  )
}
