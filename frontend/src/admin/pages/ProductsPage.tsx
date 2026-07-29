import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  BulkBar,
  Button,
  ColumnChooser,
  DataTable,
  EmptyState,
  FilterBar,
  MenuItem,
  Panel,
  Spinner,
  TextField,
  Toolbar,
  activeCount,
  applyFilters,
  readHidden,
  useConfirm,
  writeHidden,
} from '../components/ui'
import type { BadgeTone, Column, FilterField, FilterRule } from '../components/ui'
import { api, apiJson, apiUrl } from '../../shared/api'
import { slugifyAscii } from '../lib/slug'
import { CATEGORY_SLUG_MAX, CATEGORY_TITLE_MAX, PRODUCT_SLUG_MAX, PRODUCT_TITLE_MAX } from '../features/catalogue/constraints'
import type { Category, Product, ProductListing, ProductStatus } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: '草稿',
  active: '上架中',
  archived: '已下架',
}

const STATUS_TONES: Record<ProductStatus, BadgeTone> = {
  draft: 'neutral',
  active: 'success',
  archived: 'warning',
}

const COLUMN_PAGE = 'products'

/** The slug is only wanted when a link is being checked, so it starts folded away. */
const DEFAULT_HIDDEN = ['slug']

/** Turns a title into a starting slug, which the owner can still overwrite. */
function suggestSlug(title: string): string {
  return slugifyAscii(title, PRODUCT_SLUG_MAX)
}

export function ProductsPage() {
  const [listing, setListing] = useState<ProductListing | null>(null)
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [newCategory, setNewCategory] = useState({ title: '', slug: '' })
  const [search, setSearch] = useState('')
  const [rules, setRules] = useState<FilterRule[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [hidden, setHidden] = useState<string[]>(() => readHidden(COLUMN_PAGE) ?? DEFAULT_HIDDEN)
  const [selected, setSelected] = useState<string[]>([])
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      setListing(await api<ProductListing>('/api/products'))
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  function chooseColumns(next: string[]) {
    setHidden(next)
    writeHidden(COLUMN_PAGE, next)
  }

  async function create(event: Event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      // The slug field is optional in the form but not in the API: an empty
      // one means "derive it from the title", which is what most will want.
      await apiJson('/api/products', 'POST', {
        title,
        slug: slug.trim() || suggestSlug(title),
        description: '',
        status: 'draft',
      })
      setTitle('')
      setSlug('')
      show('商品已建立，現在是草稿狀態。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function remove(product: Product) {
    const ok = await ask({
      title: '刪除商品',
      body: (
        <>
          <p>確定要刪除「{product.title}」嗎？</p>
          <p>它的規格與照片會一併移除，這個動作無法還原。</p>
        </>
      ),
      confirmLabel: '刪除',
    })
    if (!ok) return
    try {
      await api(`/api/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' })
      setSelected((current) => current.filter((id) => id !== product.id))
      show('商品已刪除。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    }
  }

  /** Bulk delete — the same power the row menu already has, applied to a list. */
  async function removeSelected() {
    const targets = products.filter((product) => selected.includes(product.id))
    if (targets.length === 0) return
    const ok = await ask({
      title: `刪除 ${targets.length} 件商品`,
      body: (
        <>
          <p>以下商品會被刪除，連同它們的規格與照片。這個動作無法還原。</p>
          <ul class="ui-name-list">
            {targets.map((product) => (
              <li key={product.id}>
                {product.title}
                <code>/{product.slug}</code>
              </li>
            ))}
          </ul>
        </>
      ),
      confirmLabel: `刪除這 ${targets.length} 件`,
    })
    if (!ok) return
    if (busy) return
    setBusy(true)
    try {
      for (const product of targets) {
        await api(`/api/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' })
      }
      setSelected([])
      show(`已刪除 ${targets.length} 件商品。`, 'ok')
      await load()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function addCategory(event: Event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await apiJson('/api/categories', 'POST', {
        title: newCategory.title,
        slug: newCategory.slug.trim() || suggestSlug(newCategory.title),
        description: '',
      })
      setNewCategory({ title: '', slug: '' })
      show('分類已建立。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function renameCategory(category: Category, next: string) {
    if (next === category.title) return
    try {
      await apiJson(`/api/categories/${encodeURIComponent(category.id)}`, 'PUT', { ...category, title: next })
      await load()
    } catch (error) {
      showError(error)
    }
  }

  async function removeCategory(category: Category) {
    // Worth spelling out: deleting a label does not delete what it was on.
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

  /**
   * A changed filter drops the selection: the rows behind a bulk button are
   * not the rows that were ticked before it.
   */
  function changeRules(next: FilterRule[]) {
    setRules(next)
    setSelected([])
  }

  const products = useMemo(() => listing?.products ?? [], [listing])
  const categories = listing?.categories ?? []

  const fields: FilterField[] = [
    {
      name: 'status',
      label: '狀態',
      type: 'enum',
      options: (Object.keys(STATUS_LABELS) as ProductStatus[]).map((status) => ({
        value: status,
        label: STATUS_LABELS[status],
      })),
    },
    {
      name: 'category',
      label: '分類',
      type: 'enum',
      options: categories.map((category) => ({ value: category.id, label: category.title })),
    },
  ]

  /**
   * **Products filter in the browser.** `/api/products` already hands back
   * the whole catalogue in one call — every product, its variants, its photos
   * and its categories — because the editor needs all of it anyway. Filtering
   * what is already here is instant and, unlike the orders list, complete:
   * there is no page beyond this one for a rule to miss. The day this shop
   * has thousands of products the call itself is the thing that has to change,
   * and this filter goes with it.
   */
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const found = needle
      ? products.filter(
          (product) =>
            product.title.toLowerCase().includes(needle) || product.slug.toLowerCase().includes(needle),
        )
      : products
    return applyFilters(found, rules, fields, (product, field) =>
      field === 'category'
        ? (listing?.productCategories?.[product.id] ?? []).map((category) => category.id)
        : product.status,
    )
  }, [products, rules, search, listing, fields])

  const filtered = activeCount(rules) > 0 || search.trim() !== ''

  function priceOf(id: string): string {
    const priced = (listing?.variants[id] ?? []).filter((variant) => variant.enabled)
    if (priced.length === 0) return ''
    const low = Math.min(...priced.map((variant) => variant.price))
    const high = Math.max(...priced.map((variant) => variant.price))
    return low === high ? `NT$${low}` : `NT$${low}–${high}`
  }

  const columns: Column<Product>[] = [
    {
      key: 'title',
      label: '商品',
      // The thumbnail and the name are the row. Hiding them would leave a
      // list of prices belonging to nothing.
      fixed: true,
      render: (product) => {
        const cover = listing?.images[product.id]?.[0]?.path
        return (
          <a class="product-cell" href={`/products/${encodeURIComponent(product.id)}`}>
            <span class="thumb">{cover ? <img src={apiUrl(cover)} alt="" /> : null}</span>
            <span class="name">{product.title}</span>
          </a>
        )
      },
    },
    {
      key: 'status',
      label: '狀態',
      render: (product) => <Badge tone={STATUS_TONES[product.status]}>{STATUS_LABELS[product.status]}</Badge>,
    },
    { key: 'slug', label: '網址代稱', render: (product) => <code>/{product.slug}</code> },
    {
      key: 'price',
      label: '售價',
      numeric: true,
      // A product with no enabled variant has no price and cannot be bought,
      // so the list says so rather than showing an empty cell.
      render: (product) => priceOf(product.id) || <span class="warn">尚未設定規格</span>,
    },
    {
      key: 'stock',
      label: '庫存',
      numeric: true,
      render: (product) => (listing?.variants[product.id] ?? []).reduce((total, variant) => total + variant.stock, 0),
    },
    {
      key: 'images',
      label: '照片',
      numeric: true,
      render: (product) => (listing?.images[product.id] ?? []).length,
    },
    {
      key: 'categories',
      label: '分類',
      render: (product) =>
        (listing?.productCategories?.[product.id] ?? []).map((category) => category.title).join('、') || '—',
    },
  ]

  return (
    <AdminShell current="/products" message={message} onError={showError}>
      {dialog}

      <Panel title="新增商品">
        <form class="ui-inline-form" onSubmit={create}>
          <TextField
            label="商品名稱"
            value={title}
            maxLength={PRODUCT_TITLE_MAX}
            required
            onInput={(event) => setTitle((event.currentTarget as HTMLInputElement).value)}
          />
          <TextField
            label="網址代稱"
            value={slug}
            maxLength={PRODUCT_SLUG_MAX}
            placeholder={suggestSlug(title) || '留空自動產生'}
            onInput={(event) => setSlug((event.currentTarget as HTMLInputElement).value)}
          />
          <Button type="submit" tone="primary" busy={busy} disabled={!title.trim()}>
            新增商品
          </Button>
        </form>
      </Panel>

      <Panel title="商品">
        <Toolbar>
          <TextField
            label="搜尋"
            type="search"
            placeholder="商品名稱或網址代稱"
            value={search}
            onInput={(event) => setSearch((event.currentTarget as HTMLInputElement).value)}
          />
          <div class="ui-toolbar-end">
            <Button size="sm" onClick={() => setShowFilters((open) => !open)}>
              篩選{activeCount(rules) > 0 ? ` (${activeCount(rules)})` : ''}
            </Button>
            <ColumnChooser columns={columns} hidden={hidden} onChange={chooseColumns} />
          </div>
        </Toolbar>

        {showFilters && (
          <FilterBar fields={fields} rules={rules} onChange={changeRules} />
        )}

        <BulkBar count={selected.length} onClear={() => setSelected([])}>
          <Button size="sm" tone="danger" busy={busy} onClick={() => void removeSelected()}>
            刪除
          </Button>
        </BulkBar>

        {listing === null ? (
          <Spinner />
        ) : (
          <DataTable
            rows={shown}
            columns={columns}
            hidden={hidden}
            rowKey={(product) => product.id}
            selected={selected}
            onSelectedChange={setSelected}
            rowClass={(product) => `product-${product.status}`}
            menu={(product) => (
              <>
                <MenuItem onClick={() => location.assign(`/products/${encodeURIComponent(product.id)}`)}>
                  編輯
                </MenuItem>
                <MenuItem tone="danger" onClick={() => void remove(product)}>
                  刪除
                </MenuItem>
              </>
            )}
            empty={
              filtered ? (
                <EmptyState
                  title="沒有符合的商品"
                  body="條件把所有商品都排除了。放寬一條，或清掉全部從頭看。"
                  action={
                    <Button
                      onClick={() => {
                        setRules([])
                        setSearch('')
                      }}
                    >
                      清除搜尋與篩選
                    </Button>
                  }
                />
              ) : (
                <EmptyState title="還沒有商品" body="用上面的欄位新增第一個。它會是草稿，顧客還看不到。" />
              )
            }
          />
        )}
      </Panel>

      <Panel title="分類">
        <p class="muted">
          分類是貼在商品上的標籤，沒有階層。前台網址是 <code>/shop/c/代稱</code>，多個分類用逗號代表「任一」、加號代表「兩者皆是」。
        </p>

        <form class="ui-inline-form" onSubmit={addCategory}>
          <TextField
            label="分類名稱"
            value={newCategory.title}
            maxLength={CATEGORY_TITLE_MAX}
            required
            onInput={(event) =>
              setNewCategory({ ...newCategory, title: (event.currentTarget as HTMLInputElement).value })
            }
          />
          <TextField
            label="網址代稱"
            value={newCategory.slug}
            maxLength={CATEGORY_SLUG_MAX}
            placeholder={suggestSlug(newCategory.title) || '留空自動產生'}
            onInput={(event) =>
              setNewCategory({ ...newCategory, slug: (event.currentTarget as HTMLInputElement).value })
            }
          />
          <Button type="submit" tone="primary" busy={busy} disabled={!newCategory.title.trim()}>
            新增分類
          </Button>
        </form>

        {categories.length === 0 ? (
          <EmptyState title="還沒有分類" body="分類是選填的。商品沒有分類一樣賣得掉，只是逛起來少一條路。" />
        ) : (
          <ul class="category-list">
            {categories.map((category) => (
              <li key={category.id}>
                <TextField
                  label="分類名稱"
                  value={category.title}
                  maxLength={CATEGORY_TITLE_MAX}
                  onBlur={(event) => void renameCategory(category, (event.currentTarget as HTMLInputElement).value)}
                />
                <code>/shop/c/{category.slug}</code>
                <span class="count">{listing?.counts?.[category.id] ?? 0} 件上架中</span>
                <Button size="sm" tone="danger" onClick={() => void removeCategory(category)}>
                  刪除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </AdminShell>
  )
}
