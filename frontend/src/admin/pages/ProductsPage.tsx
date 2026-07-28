import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { ApiError, api, apiJson, apiUrl, clearLoginAttempt } from '../../shared/api'
import type { ProductListing, ProductStatus } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: '草稿',
  active: '上架中',
  archived: '已下架',
}

/** Turns a title into a starting slug, which the owner can still overwrite. */
function suggestSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function ProductsPage() {
  const [listing, setListing] = useState<ProductListing | null>(null)
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const load = useCallback(async () => {
    try {
      setListing(await api<ProductListing>('/api/products'))
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

  async function remove(id: string, name: string) {
    if (!confirm(`確定要刪除「${name}」？規格與照片會一併移除，且無法復原。`)) return
    try {
      await api(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' })
      show('商品已刪除。', 'ok')
      await load()
    } catch (error) {
      showError(error)
    }
  }

  const products = listing?.products ?? []

  return (
    <AdminShell current="/products" message={message} onError={showError}>
      <section class="stack shop">
        <div class="card">
          <h2>新增商品</h2>
          <form class="new-product" onSubmit={create}>
            <label>
              商品名稱
              <input
                value={title}
                onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
                maxLength={80}
                required
              />
            </label>
            <label>
              網址代稱
              <input
                value={slug}
                onInput={(event) => setSlug((event.target as HTMLInputElement).value)}
                placeholder={suggestSlug(title) || '留空自動產生'}
                maxLength={64}
              />
            </label>
            <button type="submit" disabled={busy || !title.trim()}>
              新增商品
            </button>
          </form>
        </div>

        <div class="card">
          <h2>商品</h2>
          {listing === null ? (
            <p class="muted">載入中…</p>
          ) : products.length === 0 ? (
            <p class="muted">還沒有商品。用上面的欄位新增第一個。</p>
          ) : (
            <ul class="product-list">
              {products.map((product) => {
                const variants = listing.variants[product.id] ?? []
                const images = listing.images[product.id] ?? []
                const cover = images[0]?.path
                // A product with no variant has no price and cannot be bought,
                // so it is called out here rather than only in the editor.
                const priced = variants.filter((variant) => variant.enabled)
                const low = Math.min(...priced.map((variant) => variant.price))
                const high = Math.max(...priced.map((variant) => variant.price))
                const stock = variants.reduce((total, variant) => total + variant.stock, 0)

                return (
                  <li key={product.id} class={`product-row ${product.status}`}>
                    <div class="thumb">
                      {cover ? <img src={apiUrl(cover)} alt="" /> : <span />}
                    </div>
                    <div class="detail">
                      <a class="name" href={`/products/${encodeURIComponent(product.id)}`}>
                        {product.title}
                      </a>
                      <p class="meta">
                        <span class={`badge ${product.status}`}>{STATUS_LABELS[product.status]}</span>
                        <code>/{product.slug}</code>
                      </p>
                      <p class="meta">
                        {priced.length === 0 ? (
                          <span class="warn">尚未設定規格，無法販售</span>
                        ) : (
                          <span>{low === high ? `NT$${low}` : `NT$${low}–${high}`}</span>
                      )}
                      <span>庫存 {stock}</span>
                      <span>{images.length} 張照片</span>
                    </p>
                  </div>
                  <div class="actions">
                    <a class="edit" href={`/products/${encodeURIComponent(product.id)}`}>
                      編輯
                    </a>
                    <button type="button" class="danger" onClick={() => void remove(product.id, product.title)}>
                      刪除
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
          )}
        </div>
      </section>
    </AdminShell>
  )
}
