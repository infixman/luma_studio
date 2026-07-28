import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Badge, Button, EmptyState, Panel, Spinner, TextField, Toggle, useConfirm } from '../components/ui'
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
  const { ask, dialog } = useConfirm()

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
    const ok = await ask({
      title: '刪除頁面',
      body: (
        <>
          <p>
            確定要刪除「{page.title}」（<code>{page.isHome ? '/' : page.path}</code>）嗎？
          </p>
          <p>這一頁上的區塊會一併移除，而且無法復原。</p>
        </>
      ),
      confirmLabel: '刪除頁面',
    })
    if (!ok) return
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
      {dialog}

      <Panel title="新增頁面">
        <form onSubmit={create}>
          <div class="field-pair">
            <TextField
              label="頁面名稱"
              value={draft.title}
              onInput={(event) => setDraft({ ...draft, title: (event.currentTarget as HTMLInputElement).value })}
              maxLength={80}
              required
            />
            <TextField
              label="網址路徑"
              value={draft.path}
              onInput={(event) => setDraft({ ...draft, path: (event.currentTarget as HTMLInputElement).value })}
              placeholder={suggestPath(draft.title) || '留空自動產生'}
              hint="首頁不用填——建好之後把下面的「首頁」打開就會接管 /"
              maxLength={120}
            />
          </div>
          <Button type="submit" tone="primary" busy={busy} disabled={!draft.title.trim()}>
            新增頁面
          </Button>
        </form>
      </Panel>

      <Panel title="頁面">
        {pages === null ? (
          <Spinner />
        ) : pages.length === 0 ? (
          <EmptyState title="還沒有頁面" body="用上面的欄位建立第一頁。建好的頁面預設是草稿，公開之後才會出現在前台。" />
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
                    {page.isHome && <Badge tone="primary">首頁</Badge>}
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
                      <Badge>草稿</Badge>
                    )}
                  </p>
                </div>
                <div class="actions">
                  <Toggle
                    label="公開"
                    checked={page.status === 'published'}
                    onChange={(on) => void save(page, { status: on ? 'published' : 'draft' })}
                  />
                  <Toggle label="首頁" checked={page.isHome} onChange={(isHome) => void save(page, { isHome })} />
                  <Button size="sm" onClick={() => location.assign(`/pages/${encodeURIComponent(page.id)}`)}>
                    編輯
                  </Button>
                  <Button size="sm" tone="danger" onClick={() => void remove(page)}>
                    刪除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminShell>
  )
}
