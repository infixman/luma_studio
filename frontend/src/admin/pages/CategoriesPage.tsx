import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Button, EmptyState, IconButton, Panel, Spinner, TextField, useConfirm } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import { CATEGORY_SLUG_MAX, CATEGORY_TITLE_MAX } from '../features/catalogue/constraints'
import { slugifyAscii } from '../lib/slug'
import type { Category } from '../../shared/types'
import '../styles/shop-admin.css'

interface CategoryListing {
  categories: Category[]
  counts: Record<string, number>
}

function suggestSlug(title: string): string {
  return slugifyAscii(title, CATEGORY_SLUG_MAX)
}

export function CategoriesPage() {
  const [listing, setListing] = useState<CategoryListing | null>(null)
  const [draft, setDraft] = useState({ title: '', slug: '' })
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      setListing(await api<CategoryListing>('/api/categories'))
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  async function addCategory(event: Event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await apiJson('/api/categories', 'POST', {
        title: draft.title.trim(),
        slug: draft.slug.trim() || suggestSlug(draft.title),
        description: '',
      })
      setDraft({ title: '', slug: '' })
      show('分類已建立。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function renameCategory(category: Category, title: string) {
    const next = title.trim()
    if (!next || next === category.title) return
    try {
      await apiJson(`/api/categories/${encodeURIComponent(category.id)}`, 'PUT', {
        ...category,
        title: next,
      })
      show('分類名稱已更新。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    }
  }

  async function removeCategory(category: Category) {
    const ok = await ask({
      title: '刪除分類',
      body: (
        <>
          <p>確定要刪除分類「{category.title}」嗎？</p>
          <p>商品不會被刪除，只會失去這個分類。</p>
        </>
      ),
      confirmLabel: '刪除',
    })
    if (!ok) return
    try {
      await api(`/api/categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' })
      show('分類已刪除。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    }
  }

  const suggested = suggestSlug(draft.title)
  const canCreate = draft.title.trim() !== '' && (draft.slug.trim() !== '' || suggested !== '')

  return (
    <AdminShell current="/categories" message={message} onError={showError}>
      {dialog}

      <Panel class="category-manager-panel">
        <div class="category-manager">
          <section class="category-create-section" aria-labelledby="category-create-title">
            <header class="category-section-head">
              <h2 id="category-create-title">新增分類</h2>
              <p>用分類整理商品；網址代稱會成為前台分類頁的路徑。</p>
            </header>

            <form class="category-create-form" onSubmit={addCategory}>
              <TextField
                label="分類名稱"
                value={draft.title}
                maxLength={CATEGORY_TITLE_MAX}
                required
                onInput={(event) =>
                  setDraft({ ...draft, title: (event.currentTarget as HTMLInputElement).value })
                }
              />
              <TextField
                label="網址代稱"
                value={draft.slug}
                maxLength={CATEGORY_SLUG_MAX}
                placeholder={suggested || '中文名稱請填英文代稱'}
                hint="只使用英文字母、數字與連字號。"
                onInput={(event) =>
                  setDraft({ ...draft, slug: (event.currentTarget as HTMLInputElement).value })
                }
              />
              <Button type="submit" tone="primary" busy={busy} disabled={!canCreate}>
                新增分類
              </Button>
            </form>
          </section>

          <section class="category-list-section" aria-labelledby="category-list-title">
            <header class="category-section-head is-row">
              <div>
                <h2 id="category-list-title">現有分類</h2>
                <p>直接修改名稱；網址代稱建立後保持不變，避免舊連結失效。</p>
              </div>
              {listing && <span class="category-total">{listing.categories.length} 個分類</span>}
            </header>

            {listing === null ? (
              <Spinner />
            ) : listing.categories.length === 0 ? (
              <EmptyState title="還沒有分類" body="分類是選填的；建立後即可在商品資料中勾選。" />
            ) : (
              <ul class="category-list">
                {listing.categories.map((category) => (
                  <li key={category.id}>
                    <div class="category-name">
                      <TextField
                        label={`${category.title}的分類名稱`}
                        value={category.title}
                        maxLength={CATEGORY_TITLE_MAX}
                        onBlur={(event) =>
                          void renameCategory(category, (event.currentTarget as HTMLInputElement).value)
                        }
                      />
                    </div>
                    <div class="category-route">
                      <code>/shop/c/{category.slug}</code>
                      <span class="count">{listing.counts[category.id] ?? 0} 件上架中</span>
                    </div>
                    <IconButton
                      label={`刪除分類「${category.title}」`}
                      size="sm"
                      tone="danger"
                      onClick={() => void removeCategory(category)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14" />
                      </svg>
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Panel>
    </AdminShell>
  )
}
