import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { ApiError, api, apiJson, apiUrl, clearLoginAttempt, uploadProductImage } from '../../shared/api'
import type { ProductDetail, ProductStatus, ProductVariant } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'

const STATUSES: { value: ProductStatus; label: string; hint: string }[] = [
  { value: 'draft', label: '草稿', hint: '只有你看得到' },
  { value: 'active', label: '上架中', hint: '顧客可以看到並購買' },
  { value: 'archived', label: '已下架', hint: '保留紀錄，但不再販售' },
]

const MAX_IMAGES = 8

/** A blank row for the "add variant" form, and what reset returns it to. */
const EMPTY_VARIANT = { title: '', sku: '', price: '', stock: '' }

export function ProductEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [form, setForm] = useState({ title: '', slug: '', description: '', status: 'draft' as ProductStatus })
  const [draft, setDraft] = useState(EMPTY_VARIANT)
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const apply = useCallback((next: ProductDetail) => {
    setDetail(next)
    setForm({
      title: next.product.title,
      slug: next.product.slug,
      description: next.product.description,
      status: next.product.status,
    })
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await api<ProductDetail>(`/api/products/${encodeURIComponent(id)}`))
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [apply, id, showError])

  useEffect(() => {
    void load()
  }, [load])

  async function run(work: () => Promise<ProductDetail | void>, done: string) {
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

  function saveProduct(event: Event) {
    event.preventDefault()
    void run(
      () => apiJson<ProductDetail>(`/api/products/${encodeURIComponent(id)}`, 'PUT', form),
      '商品已儲存。',
    )
  }

  function addVariant(event: Event) {
    event.preventDefault()
    void run(async () => {
      // The API refuses anything that is not already a whole number, so the
      // conversion happens here rather than being left to the server to guess.
      const next = await apiJson<ProductDetail>(`/api/products/${encodeURIComponent(id)}/variants`, 'POST', {
        title: draft.title,
        sku: draft.sku,
        price: Number.parseInt(draft.price, 10),
        stock: Number.parseInt(draft.stock, 10),
      })
      setDraft(EMPTY_VARIANT)
      return next
    }, '規格已新增。')
  }

  function saveVariant(variant: ProductVariant, patch: Partial<ProductVariant>) {
    const next = { ...variant, ...patch }
    void run(
      () =>
        apiJson<ProductDetail>(`/api/variants/${encodeURIComponent(variant.id)}`, 'PUT', {
          title: next.title,
          sku: next.sku,
          price: next.price,
          stock: next.stock,
          enabled: next.enabled,
        }),
      '規格已更新。',
    )
  }

  function removeVariant(variant: ProductVariant) {
    if (!confirm(`確定要刪除規格「${variant.title}」？`)) return
    void run(
      () => api<ProductDetail>(`/api/variants/${encodeURIComponent(variant.id)}`, { method: 'DELETE' }),
      '規格已刪除。',
    )
  }

  function uploadPhoto(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    void run(async () => {
      const next = await uploadProductImage(id, file, '')
      input.value = ''
      return next
    }, '照片已上傳。')
  }

  function removePhoto(imageId: string) {
    void run(() => api<ProductDetail>(`/api/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' }), '照片已移除。')
  }

  if (detail === null) {
    return (
      <AdminShell current="/products" message={message} onError={showError}>
        <section class="stack shop">
          <div class="card">
            <p class="muted">載入中…</p>
          </div>
        </section>
      </AdminShell>
    )
  }

  const sellable = detail.variants.some((variant) => variant.enabled)

  return (
    <AdminShell current="/products" message={message} onError={showError}>
      <section class="stack shop">
        <p class="crumb">
          <a href="/products">← 回到商城</a>
        </p>
        <h2 class="product-heading">{detail.product.title}</h2>

        {!sellable && detail.product.status === 'active' && (
          <p class="notice warn">這個商品已上架，但沒有任何啟用的規格，顧客看得到卻買不了。</p>
        )}

        <div class="card">
          <h3>商品資料</h3>
          <form class="product-form" onSubmit={saveProduct}>
            <label>
              商品名稱
              <input
                value={form.title}
                onInput={(event) => setForm({ ...form, title: (event.target as HTMLInputElement).value })}
                maxLength={80}
                required
              />
            </label>
            <label>
              網址代稱
              <input
                value={form.slug}
                onInput={(event) => setForm({ ...form, slug: (event.target as HTMLInputElement).value })}
                maxLength={64}
                required
              />
              <small>顧客看到的網址是 /shop/{form.slug || '…'}，改動會讓舊連結失效。</small>
            </label>
            <label>
              商品說明
              <textarea
                value={form.description}
                onInput={(event) => setForm({ ...form, description: (event.target as HTMLTextAreaElement).value })}
                maxLength={2000}
                rows={6}
              />
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
              儲存商品
            </button>
          </form>
        </div>

        <section class="card variants">
          <h3>規格與庫存</h3>
          {detail.variants.length === 0 && <p class="muted">還沒有規格。至少要有一個，商品才能販售。</p>}
          <ul>
            {detail.variants.map((variant) => (
              <li key={variant.id} class={variant.enabled ? 'variant' : 'variant off'}>
                <span class="variant-title">{variant.title}</span>
                {variant.sku && <code>{variant.sku}</code>}
                <label>
                  售價
                  <input
                    type="number"
                    min={1}
                    max={20000}
                    step={1}
                    value={variant.price}
                    onChange={(event) =>
                      saveVariant(variant, { price: Number.parseInt((event.target as HTMLInputElement).value, 10) })
                    }
                  />
                </label>
                <label>
                  庫存
                  <input
                    type="number"
                    min={0}
                    max={100000}
                    step={1}
                    value={variant.stock}
                    onChange={(event) =>
                      saveVariant(variant, { stock: Number.parseInt((event.target as HTMLInputElement).value, 10) })
                    }
                  />
                </label>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={variant.enabled}
                    onChange={(event) => saveVariant(variant, { enabled: (event.target as HTMLInputElement).checked })}
                  />
                  啟用
                </label>
                <button type="button" class="danger" onClick={() => removeVariant(variant)}>
                  刪除
                </button>
              </li>
            ))}
          </ul>

          <form class="new-variant" onSubmit={addVariant}>
            <input
              placeholder="規格名稱，例如 M／藍"
              value={draft.title}
              onInput={(event) => setDraft({ ...draft, title: (event.target as HTMLInputElement).value })}
              maxLength={60}
              required
            />
            <input
              placeholder="貨號（選填）"
              value={draft.sku}
              onInput={(event) => setDraft({ ...draft, sku: (event.target as HTMLInputElement).value })}
              maxLength={40}
            />
            <input
              type="number"
              placeholder="售價"
              min={1}
              max={20000}
              step={1}
              value={draft.price}
              onInput={(event) => setDraft({ ...draft, price: (event.target as HTMLInputElement).value })}
              required
            />
            <input
              type="number"
              placeholder="庫存"
              min={0}
              max={100000}
              step={1}
              value={draft.stock}
              onInput={(event) => setDraft({ ...draft, stock: (event.target as HTMLInputElement).value })}
              required
            />
            <button type="submit" disabled={busy}>
              新增規格
            </button>
          </form>
        </section>

        <section class="card photos">
          <h3>照片</h3>
          <p class="muted">第一張是列表上的封面。最多 {MAX_IMAGES} 張，每張 3 MB 以內。</p>
          <ul class="photo-grid">
            {detail.images.map((image) => (
              <li key={image.id}>
                {image.path && <img src={apiUrl(image.path)} alt={image.alt} />}
                <button type="button" class="danger" onClick={() => removePhoto(image.id)}>
                  移除
                </button>
              </li>
            ))}
          </ul>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy || detail.images.length >= MAX_IMAGES}
            onChange={uploadPhoto}
          />
        </section>
      </section>
    </AdminShell>
  )
}
