import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../../components/AdminShell'
import { OpenButton } from '../../components/IconButtons'
import { SlugLock } from '../../components/SlugLock'
import { useStatus } from '../../components/StatusBar'
import {
  Badge,
  Button,
  EmptyState,
  Menu,
  MenuItem,
  Modal,
  Panel,
  Spinner,
  TextField,
  Toggle,
  useConfirm,
} from '../../components/ui'
import { navigate } from '../../lib/navigation'
import { nextPath, suggestPath } from '../../lib/slug'
import { STOREFRONT_ORIGIN, api, apiJson } from '../../../shared/api'
import { PAGE_PATH_MAX, PAGE_TITLE_MAX } from './constraints'
import type { Page } from '../../../shared/types'
import '../../styles/pages-admin.css'

/** Named because the submit button sits outside the form and points at it. */
const CREATE_FORM = 'new-page'

export function PagesPage() {
  const [pages, setPages] = useState<Page[] | null>(null)
  const [creating, setCreating] = useState(false)
  /* The lock starts shut on a page that does not exist yet: there is no
     address to protect, so following the title is free. */
  const [draft, setDraft] = useState({ title: '', path: '', locked: true })
  const { message, show, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      const data = await api<{ pages: Page[] }>('/api/pages')
      setPages(data.pages)
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  /* What the page would actually be created at. A locked field is already
     filled by the title, so this only has anything left to do when the lock
     is open and the owner left the box empty. */
  const newPath = draft.path.trim() || suggestPath(draft.title)

  function create(event: Event) {
    event.preventDefault()
    void run(async () => {
      await apiJson('/api/pages', 'POST', {
        title: draft.title,
        path: newPath,
        status: 'draft',
      })
      setDraft({ title: '', path: '', locked: true })
      await load()
    }, '頁面已建立，現在是草稿。')
  }

  async function save(page: Page, patch: Partial<Page>) {
    try {
      await apiJson(`/api/pages/${encodeURIComponent(page.id)}`, 'PUT', { ...page, ...patch })
      await load()
    } catch (error) {
      showError(error)
    }
  }

  /**
   * Publish or withdraw one page from the list.
   *
   * Publishing here publishes whatever the draft currently holds — the same
   * thing the editor's button does, through the same endpoint. A page with no
   * blocks is refused by the server rather than going live empty.
   */
  async function setLive(page: Page, live: boolean) {
    try {
      await apiJson(
        `/api/pages/${encodeURIComponent(page.id)}/${live ? 'publish' : 'unpublish'}`,
        'POST',
        {},
      )
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
    <AdminShell
      current="/pages"
      message={message}
      onError={showError}
      actions={
        <Button tone="primary" onClick={() => setCreating(true)}>
          新增頁面
        </Button>
      }
    >
      {dialog}

      {/* The buttons sit in the dialog's own footer, which already orders
          them; `form=` is how the submit reaches the fields from out there. */}
      <Modal
        title="新增頁面"
        open={creating}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button
              type="submit"
              form={CREATE_FORM}
              tone="primary"
              busy={busy}
              disabled={!draft.title.trim() || !newPath}
            >
              新增頁面
            </Button>
          </>
        }
      >
        <form id={CREATE_FORM} onSubmit={create}>
          <div class="field-pair">
            <TextField
              label="頁面名稱"
              value={draft.title}
              onInput={(event) => {
                const title = (event.currentTarget as HTMLInputElement).value
                // The path keeps up with the title rather than being guessed
                // once and then left behind — that drift is what the lock is
                // here to end.
                setDraft((current) => ({ ...current, title, path: nextPath(current.path, title, current.locked) }))
              }}
              maxLength={PAGE_TITLE_MAX}
              required
            />
            <TextField
              label="網址路徑"
              value={draft.path}
              onInput={(event) => setDraft({ ...draft, path: (event.currentTarget as HTMLInputElement).value })}
              disabled={draft.locked}
              trailing={<SlugLock locked={draft.locked} onChange={(locked) => setDraft({ ...draft, locked })} />}
              placeholder={suggestPath(draft.title) || '留空自動產生'}
              hint={
                /* A Chinese title romanises to nothing, so automatic mode can
                   leave this empty. The named action makes the escape clear. */
                draft.locked && !newPath
                  ? '頁面名稱裡沒有可以放進網址的英數字。按右邊「手動輸入」設定一個，例如 /about。'
                  : draft.locked
                    ? '網址會跟著頁面名稱更新。要自訂網址，按右邊「手動輸入」。'
                    : '請輸入網址，例如 /about。建好後可在下方把這一頁設為首頁。'
              }
              maxLength={PAGE_PATH_MAX}
            />
          </div>
        </form>
      </Modal>

      {/* No title: the navigation and the title bar both already say 頁面. */}
      <Panel>
        {pages === null ? (
          <Spinner />
        ) : pages.length === 0 ? (
          <EmptyState title="還沒有頁面" body="用上面的欄位建立第一頁。建好的頁面預設是草稿，公開之後才會出現在前台。" />
        ) : (
          <ul class="page-list">
            {pages.map((page) => (
              <li key={page.id} class={page.status === 'published' ? 'page-row' : 'page-row draft'}>
                <div class="detail">
                  <span class="title-row">
                    <a class="name" href={`/pages/${encodeURIComponent(page.id)}`}>
                      {page.title}
                    </a>
                    {page.status === 'published' && (
                      <OpenButton
                        url={`${STOREFRONT_ORIGIN}${page.isHome ? '' : page.path}`}
                        label={page.title}
                      />
                    )}
                  </span>
                  <p class="meta">
                    <code>{page.isHome ? '/' : page.path}</code>
                    {page.isHome && <Badge tone="primary">首頁</Badge>}
                    {page.publishState === 'modified' ? (
                      <Badge tone="warning">有未發布的修改</Badge>
                    ) : page.publishState === 'published' ? (
                      <Badge tone="success">已發布</Badge>
                    ) : (
                      <Badge>草稿</Badge>
                    )}
                  </p>
                </div>
                <div class="actions">
                  {/* Through the same endpoints the editor uses. Setting
                      `status` directly would leave a page marked published
                      with no version to serve, which is a 404 wearing a
                      green badge. */}
                  <Toggle
                    label="公開"
                    checked={page.status === 'published'}
                    onChange={(on) => void setLive(page, on)}
                  />
                  <Toggle label="首頁" checked={page.isHome} onChange={(isHome) => void save(page, { isHome })} />
                  <Menu label={`「${page.title}」的操作`}>
                    <MenuItem onClick={() => navigate(`/pages/${encodeURIComponent(page.id)}`)}>編輯</MenuItem>
                    <MenuItem tone="danger" onClick={() => void remove(page)}>
                      刪除
                    </MenuItem>
                  </Menu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminShell>
  )
}
