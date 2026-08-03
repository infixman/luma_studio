import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Button,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  Modal,
  Panel,
  Spinner,
  TextField,
  useConfirm,
} from '../components/ui'
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

function CategoryNameEditor({
  category,
  onSave,
}: {
  category: Category
  onSave: (title: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(category.title)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue(category.title)
  }, [category.title])

  useEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])

  const changed = value.trim() !== '' && value.trim() !== category.title

  async function save() {
    if (!changed || saving) return
    setSaving(true)
    const saved = await onSave(value)
    setSaving(false)
    if (saved) setEditing(false)
  }

  if (!editing) {
    return (
      <div class="category-name-display">
        <span>{category.title}</span>
        <IconButton
          label={`編輯分類「${category.title}」`}
          size="sm"
          onClick={() => setEditing(true)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
            <path d="m13.8 7.7 3 3" />
          </svg>
        </IconButton>
      </div>
    )
  }

  return (
    <div class="category-name-editor">
      <TextField
        ref={input}
        label={`${category.title}的分類名稱`}
        value={value}
        maxLength={CATEGORY_TITLE_MAX}
        required
        trailing={
          <IconButton
            label={`儲存分類「${category.title}」`}
            size="sm"
            class="category-save-button"
            disabled={!changed || saving}
            onClick={() => void save()}
          >
            {saving ? (
              <span class="ui-spinner" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 4h12l2 2v14H5V4Z" />
                <path d="M8 4v6h8V4M8 20v-6h8v6" />
              </svg>
            )}
          </IconButton>
        }
        onInput={(event) => setValue((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault()
            void save()
          }
          if (event.key === 'Escape') {
            setValue(category.title)
            setEditing(false)
          }
        }}
      />
    </div>
  )
}

/** Named because the submit button sits in the dialog's own footer. */
const CREATE_FORM = 'new-category'

export function CategoriesPage() {
  const [listing, setListing] = useState<CategoryListing | null>(null)
  const [draft, setDraft] = useState({ title: '', slug: '' })
  const [creating, setCreating] = useState(false)
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
      setCreating(false)
      show('分類已建立。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function renameCategory(category: Category, title: string): Promise<boolean> {
    const next = title.trim()
    if (!next || next === category.title) return false
    try {
      await apiJson(`/api/categories/${encodeURIComponent(category.id)}`, 'PUT', {
        ...category,
        title: next,
      })
      show('分類名稱已更新。', 'ok')
      await load()
      return true
    } catch (error) {
      showError(error)
      return false
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
    <AdminShell
      current="/categories"
      message={message}
      onError={showError}
      actions={
        <Button tone="primary" onClick={() => setCreating(true)}>
          新增分類
        </Button>
      }
    >
      {dialog}

      {/* No title and no section headings. With the create form behind the
          title bar there is one thing on this page — the list — and a page
          with one thing on it does not need that thing labelled. */}
      <Panel class="category-manager-panel">
        {listing === null ? (
          <Spinner />
        ) : listing.categories.length === 0 ? (
          <EmptyState title="還沒有分類" body="分類是選填的；建立後即可在商品資料中勾選。" />
        ) : (
          <ul class="category-list">
            {listing.categories.map((category) => (
              <li key={category.id}>
                <div class="category-name">
                  <CategoryNameEditor
                    category={category}
                    onSave={(title) => renameCategory(category, title)}
                  />
                </div>
                <div class="category-route">
                  <code>/shop/c/{category.slug}</code>
                  <span class="count">{listing.counts[category.id] ?? 0} 件上架中</span>
                </div>
                <Menu label={`「${category.title}」的操作`}>
                  <MenuItem tone="danger" onClick={() => void removeCategory(category)}>
                    刪除分類
                  </MenuItem>
                </Menu>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        title="新增分類"
        open={creating}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button type="submit" form={CREATE_FORM} tone="primary" busy={busy} disabled={!canCreate}>
              新增
            </Button>
          </>
        }
      >
        <form id={CREATE_FORM} onSubmit={addCategory}>
          {/* Beside the fields, not over the list: it is a rule about the
              thing being made, and this is the only moment anybody makes one. */}
          <p class="muted">網址代稱會成為前台分類頁的路徑，建立後不再更動，避免舊連結失效。</p>
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
        </form>
      </Modal>
    </AdminShell>
  )
}
