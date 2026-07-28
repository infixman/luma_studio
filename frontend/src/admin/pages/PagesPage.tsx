import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { ApiError, STOREFRONT_ORIGIN, api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { Page } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/pages-admin.css'

/** Turns a title into a starting path, which the owner can still overwrite. */
function suggestPath(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `/${slug}` : ''
}

export function PagesPage() {
  const [pages, setPages] = useState<Page[] | null>(null)
  const [draft, setDraft] = useState({ title: '', path: '' })
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const load = useCallback(async () => {
    try {
      const data = await api<{ pages: Page[] }>('/api/pages')
      setPages(data.pages)
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  async function create(event: Event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await apiJson('/api/pages', 'POST', {
        title: draft.title,
        path: draft.path.trim() || suggestPath(draft.title),
        status: 'draft',
      })
      setDraft({ title: '', path: '' })
      show('頁面已建立，現在是草稿。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function save(page: Page, patch: Partial<Page>) {
    try {
      await apiJson(`/api/pages/${encodeURIComponent(page.id)}`, 'PUT', { ...page, ...patch })
      await load()
    } catch (error) {
      showError(error)
    }
  }

  async function remove(page: Page) {
    if (!confirm(`確定要刪除「${page.title}」？頁面上的區塊會一併移除，且無法復原。`)) return
    try {
      await api(`/api/pages/${encodeURIComponent(page.id)}`, { method: 'DELETE' })
      show('頁面已刪除。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    }
  }

  return (
    <AdminShell current="/pages" message={message} onError={showError}>
      <section class="stack shop">
        <div class="card">
          <h2>新增頁面</h2>
          <form class="new-product" onSubmit={create}>
            <label>
              頁面名稱
              <input
                value={draft.title}
                onInput={(event) => setDraft({ ...draft, title: (event.target as HTMLInputElement).value })}
                maxLength={80}
                required
              />
            </label>
            <label>
              網址路徑
              <input
                value={draft.path}
                onInput={(event) => setDraft({ ...draft, path: (event.target as HTMLInputElement).value })}
                placeholder={suggestPath(draft.title) || '留空自動產生'}
                maxLength={120}
              />
            </label>
            <button type="submit" disabled={busy || !draft.title.trim()}>
              新增頁面
            </button>
          </form>
          <p class="muted">
            首頁不用填路徑——建好之後在下面勾「首頁」就會接管 <code>/</code>。
          </p>
        </div>

        <div class="card">
          <h2>頁面</h2>
          {pages === null ? (
            <p class="muted">載入中…</p>
          ) : pages.length === 0 ? (
            <p class="muted">還沒有頁面。</p>
          ) : (
            <ul class="page-list">
              {pages.map((page) => (
                <li key={page.id} class={page.status === 'published' ? 'page-row' : 'page-row draft'}>
                  <div class="detail">
                    <a class="name" href={`/pages/${encodeURIComponent(page.id)}`}>
                      {page.title}
                    </a>
                    <p class="meta">
                      <code>{page.isHome ? '/' : page.path}</code>
                      {page.isHome && <span class="badge active">首頁</span>}
                      {page.status === 'published' ? (
                        <a
                          class="visit"
                          href={`${STOREFRONT_ORIGIN}${page.isHome ? '' : page.path}`}
                          target="_blank"
                          rel="noopener"
                        >
                          開啟
                        </a>
                      ) : (
                        <span class="badge">草稿</span>
                      )}
                    </p>
                  </div>
                  <div class="actions">
                    <label class="toggle">
                      <input
                        type="checkbox"
                        checked={page.status === 'published'}
                        onChange={(event) =>
                          void save(page, {
                            status: (event.target as HTMLInputElement).checked ? 'published' : 'draft',
                          })
                        }
                      />
                      公開
                    </label>
                    <label class="toggle">
                      <input
                        type="checkbox"
                        checked={page.isHome}
                        onChange={(event) => void save(page, { isHome: (event.target as HTMLInputElement).checked })}
                      />
                      首頁
                    </label>
                    <a class="edit" href={`/pages/${encodeURIComponent(page.id)}`}>
                      編輯
                    </a>
                    <button type="button" class="danger" onClick={() => void remove(page)}>
                      刪除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </AdminShell>
  )
}
