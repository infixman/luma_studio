import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Button,
  ButtonRow,
  EmptyState,
  IconButton,
  MenuItem,
  Menu,
  Panel,
  Spinner,
  TextField,
  Toggle,
  useConfirm,
} from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { api, apiJson, apiUrl, uploadProductImage } from '../../shared/api'
import {
  ProductFormFields,
  type ProductFormValue,
} from '../features/catalogue/ProductFormFields'
import {
  PRODUCT_VARIANT_PRICE_MAX,
  PRODUCT_VARIANT_STOCK_MAX,
} from '../features/catalogue/constraints'
import type { Category, ProductDetail, ProductVariant } from '../../shared/types'
import '../styles/shop-admin.css'

const MAX_IMAGES = 8

/** A blank row for the "add variant" form, and what reset returns it to. */
const EMPTY_VARIANT = { title: '', sku: '', price: '', stock: '' }

export function ProductEditPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ProductDetail | null>(null)
  const [form, setForm] = useState<ProductFormValue>({
    title: '',
    slug: '',
    description: '',
    status: 'draft',
  })
  const [draft, setDraft] = useState(EMPTY_VARIANT)
  const [allCategories, setAllCategories] = useState<Category[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const { message, showError, busy, run } = useStatus()
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
    } catch (error) {
      showError(error)
    }
  }, [apply, id, showError])

  useEffect(() => {
    void load()
  }, [load])

  function saveProduct(event?: Event) {
    event?.preventDefault()
    void run(
      async () => apply(await apiJson<ProductDetail>(`/api/products/${encodeURIComponent(id)}`, 'PUT', { ...form, categoryIds: chosen })),
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
      apply(next)
    }, '規格已新增。')
  }

  function saveVariant(variant: ProductVariant, patch: Partial<ProductVariant>) {
    const next = { ...variant, ...patch }
    void run(
      async () =>
        apply(await apiJson<ProductDetail>(`/api/variants/${encodeURIComponent(variant.id)}`, 'PUT', {
          title: next.title,
          sku: next.sku,
          price: next.price,
          stock: next.stock,
          enabled: next.enabled,
        })),
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
      async () => apply(await api<ProductDetail>(`/api/variants/${encodeURIComponent(variant.id)}`, { method: 'DELETE' })),
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
      apply(next)
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
    void run(async () => apply(await api<ProductDetail>(`/api/images/${encodeURIComponent(imageId)}`, { method: 'DELETE' })), '照片已移除。')
  }

  if (detail === null) {
    return (
      <AdminShell current="/products" back={{ href: '/products', label: '回到商品清單' }} message={message} onError={showError}>
        <Panel title="商品">
          <Spinner />
        </Panel>
      </AdminShell>
    )
  }

  const sellable = detail.variants.some((variant) => variant.enabled)
  const productDirty =
    form.title !== detail.product.title ||
    form.slug !== detail.product.slug ||
    form.description !== detail.product.description ||
    form.status !== detail.product.status ||
    JSON.stringify([...chosen].sort()) !== JSON.stringify(detail.categories.map((category) => category.id).sort())

  return (
    <AdminShell
      current="/products"
      back={{ href: '/products', label: '回到商品清單' }}
      message={message}
      onError={showError}
      actions={
        <Button tone="primary" busy={busy} disabled={!productDirty} onClick={() => saveProduct()}>
          儲存商品
        </Button>
      }
    >
      {dialog}
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}

      <h2 class="product-heading">{detail.product.title}</h2>

      {!sellable && detail.product.status === 'active' && (
        <p class="notice warn">這個商品已上架，但沒有任何啟用的規格，顧客看得到卻買不了。</p>
      )}

      <Panel title="商品資料" class="product-info-panel">
        <form class="product-editor-form" onSubmit={saveProduct}>
          <ProductFormFields
            value={form}
            categories={allCategories}
            chosen={chosen}
            onChange={setForm}
            onChosenChange={setChosen}
            slugHint={`顧客看到的網址是 /shop/${form.slug || '…'}，改動會讓舊連結失效。`}
          />
        </form>
      </Panel>

      <Panel title="規格與庫存" class="product-variants-panel">
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
                  max={PRODUCT_VARIANT_PRICE_MAX}
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
                  max={PRODUCT_VARIANT_STOCK_MAX}
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

        <form class="ui-inline-form product-variant-create" onSubmit={addVariant}>
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
            max={PRODUCT_VARIANT_PRICE_MAX}
            step={1}
            value={draft.price}
            required
            onInput={(event) => setDraft({ ...draft, price: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="庫存"
            type="number"
            min={0}
            max={PRODUCT_VARIANT_STOCK_MAX}
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

      <Panel title="照片" class="product-photos-panel">
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
