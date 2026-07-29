import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Button,
  ButtonRow,
  Checkbox,
  EmptyState,
  IconButton,
  MenuItem,
  Menu,
  Panel,
  RadioGroup,
  Spinner,
  TextField,
  Toggle,
  useConfirm,
} from '../components/ui'
import { RichTextEditor } from '../components/RichTextEditor'
import { Lightbox } from '../components/Lightbox'
import { api, apiJson, apiUrl, clearLoginAttempt, uploadProductImage } from '../../shared/api'
import type { Category, ProductDetail, ProductStatus, ProductVariant } from '../../shared/types'
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

function textToHtml(text: string): string {
  if (!text) return ''
  if (/<[a-z][\s\S]*>/i.test(text)) return text
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function ProductEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [form, setForm] = useState({ title: '', slug: '', description: '', status: 'draft' as ProductStatus })
  const [draft, setDraft] = useState(EMPTY_VARIANT)
  const [allCategories, setAllCategories] = useState<Category[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  const apply = useCallback((next: ProductDetail) => {
    setDetail(next)
    setChosen(next.categories.map((category) => category.id))
    setForm({
      title: next.product.title,
      slug: next.product.slug,
      description: next.product.description,
      status: next.product.status,
    })
  }, [])

  const load = useCallback(async () => {
    try {
      const [detailed, listing] = await Promise.all([
        api<ProductDetail>(`/api/products/${encodeURIComponent(id)}`),
        api<{ categories: Category[] }>('/api/categories'),
      ])
      setAllCategories(listing.categories)
      apply(detailed)
      clearLoginAttempt()
    } catch (error) {
      showError(error)
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
      () => apiJson<ProductDetail>(`/api/products/${encodeURIComponent(id)}`, 'PUT', { ...form, categoryIds: chosen }),
      '商品已儲存。',
    )
  }

  function addVariant(event: Event) {
    event.preventDefault()
    void run(async () => {
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

  async function removeVariant(variant: ProductVariant) {
    const ok = await ask({
      title: '刪除規格',
      body: (
        <>
          <p>確定要刪除規格「{variant.title}」嗎？</p>
          <p>目前的 {variant.stock} 件庫存會一起消失，已經成立的訂單不受影響。</p>
        </>
      ),
      confirmLabel: '刪除',
    })
    if (!ok) return
    void run(
      () => api<ProductDetail>(`/api/variants/${encodeURIComponent(variant.id)}`, { method: 'DELETE' }),
      '規格已刪除。',
    )
  }

  function uploadPhoto(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    void run(async () => {
      const next = await uploadProductImage(id, file, '')
      input.value = ''
      return next
    }, '照片已上傳。')
  }

  async function removePhoto(imageId: string, position: number) {
    const ok = await ask({
      title: '移除照片',
      body:
        position === 0
          ? '這是列表上的封面。移除之後，下一張會遞補上來。'
          : '確定要移除這張照片嗎？這個動作無法還原。',
      confirmLabel: '移除',
    })
    if (!ok) return
    void run(() => api<ProductDetail>(`/api/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' }), '照片已移除。')
  }

  if (detail === null) {
    return (
      <AdminShell current="/products" message={message} onError={showError}>
        <Panel title="商品">
          <Spinner />
        </Panel>
      </AdminShell>
    )
  }

  const sellable = detail.variants.some((variant) => variant.enabled)

  return (
    <AdminShell current="/products" message={message} onError={showError}>
      {dialog}
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}

      <p class="crumb">
        <a href="/products">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          商品列表
        </a>
      </p>
      <h2 class="product-heading">{detail.product.title}</h2>

      {!sellable && detail.product.status === 'active' && (
        <p class="notice warn">這個商品已上架，但沒有任何啟用的規格，顧客看得到卻買不了。</p>
      )}

      <Panel title="商品資料">
        <form class="product-form" onSubmit={saveProduct}>
          <TextField
            label="商品名稱"
            value={form.title}
            maxLength={80}
            required
            onInput={(event) => setForm({ ...form, title: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="網址代稱"
            hint={`顧客看到的網址是 /shop/${form.slug || '…'}，改動會讓舊連結失效。`}
            value={form.slug}
            maxLength={64}
            required
            onInput={(event) => setForm({ ...form, slug: (event.currentTarget as HTMLInputElement).value })}
          />

          <div class="ui-field">
            <label class="ui-label">商品說明</label>
            <RichTextEditor
              config={{ body: textToHtml(form.description), format: 'html' }}
              onChange={(next) => setForm({ ...form, description: next.body })}
            />
          </div>

          <fieldset class="ui-checkbox-set">
            <legend class="ui-label">分類</legend>
            {allCategories.length === 0 ? (
              <p class="muted">還沒有分類。到商城頁的「分類」建立第一個。</p>
            ) : (
              allCategories.map((category) => (
                <Checkbox
                  key={category.id}
                  label={category.title}
                  hint={`/shop/c/${category.slug}`}
                  checked={chosen.includes(category.id)}
                  onChange={(checked) =>
                    setChosen((current) =>
                      checked ? [...current, category.id] : current.filter((value) => value !== category.id),
                    )
                  }
                />
              ))
            )}
          </fieldset>

          <RadioGroup
            legend="狀態"
            value={form.status}
            options={STATUSES}
            onChange={(status) => setForm({ ...form, status })}
          />

          <ButtonRow>
            <Button type="submit" tone="primary" busy={busy}>
              儲存商品
            </Button>
          </ButtonRow>
        </form>
      </Panel>

      <Panel title="規格與庫存">
        {detail.variants.length === 0 ? (
          <EmptyState title="還沒有規格" body="至少要有一個啟用的規格，商品才有價格、才能被買走。" />
        ) : (
          <ul class="variant-list">
            {detail.variants.map((variant) => (
              <li key={variant.id} class={variant.enabled ? 'variant' : 'variant off'}>
                <span class="variant-title">
                  {variant.title}
                  {variant.sku && <code>{variant.sku}</code>}
                </span>
                <TextField
                  label="售價"
                  type="number"
                  min={1}
                  max={20000}
                  step={1}
                  value={variant.price}
                  onChange={(event) =>
                    saveVariant(variant, {
                      price: Number.parseInt((event.currentTarget as HTMLInputElement).value, 10),
                    })
                  }
                />
                <TextField
                  label="庫存"
                  type="number"
                  min={0}
                  max={100000}
                  step={1}
                  value={variant.stock}
                  onChange={(event) =>
                    saveVariant(variant, {
                      stock: Number.parseInt((event.currentTarget as HTMLInputElement).value, 10),
                    })
                  }
                />
                <Toggle
                  label="啟用"
                  checked={variant.enabled}
                  onChange={(enabled) => saveVariant(variant, { enabled })}
                />
                <Menu label={`「${variant.title}」的動作`}>
                  <MenuItem tone="danger" disabled={busy} onClick={() => void removeVariant(variant)}>
                    刪除規格
                  </MenuItem>
                </Menu>
              </li>
            ))}
          </ul>
        )}

        <form class="ui-inline-form" onSubmit={addVariant}>
          <TextField
            label="規格名稱"
            placeholder="例如 M／藍"
            value={draft.title}
            maxLength={60}
            required
            onInput={(event) => setDraft({ ...draft, title: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="貨號"
            hint="選填"
            value={draft.sku}
            maxLength={40}
            onInput={(event) => setDraft({ ...draft, sku: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="售價"
            type="number"
            min={1}
            max={20000}
            step={1}
            value={draft.price}
            required
            onInput={(event) => setDraft({ ...draft, price: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="庫存"
            type="number"
            min={0}
            max={100000}
            step={1}
            value={draft.stock}
            required
            onInput={(event) => setDraft({ ...draft, stock: (event.currentTarget as HTMLInputElement).value })}
          />
          <Button type="submit" tone="primary" busy={busy}>
            新增規格
          </Button>
        </form>
      </Panel>

      <Panel title="照片">
        <p class="muted">
          第一張是列表上的封面。最多 {MAX_IMAGES} 張，每張 3 MB 以內。
        </p>

        {detail.images.length === 0 ? (
          <EmptyState
            title="還沒有照片"
            body="沒有照片的商品在列表上是一個空格子。"
            action={
              <Button tone="primary" onClick={() => picker.current?.click()}>
                選一張照片
              </Button>
            }
          />
        ) : (
          <ul class="photo-grid">
            {detail.images.map((image, position) => (
              <li key={image.id}>
                {image.path && (
                  <img
                    src={apiUrl(image.path)}
                    alt={image.alt}
                    onClick={() => image.path && setLightbox({ src: apiUrl(image.path), alt: image.alt })}
                  />
                )}
                <IconButton
                  label="移除這張照片"
                  tone="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => void removePhoto(image.id, position)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={picker}
          class="ui-file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || detail.images.length >= MAX_IMAGES}
          onChange={uploadPhoto}
        />
        <ButtonRow>
          <Button
            busy={busy}
            disabled={detail.images.length >= MAX_IMAGES}
            onClick={() => picker.current?.click()}
          >
            上傳照片
          </Button>
          {detail.images.length >= MAX_IMAGES && <span class="muted">已經是 {MAX_IMAGES} 張上限。</span>}
        </ButtonRow>
      </Panel>
    </AdminShell>
  )
}
