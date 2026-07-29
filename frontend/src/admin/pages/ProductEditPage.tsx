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
import { OfferComponentsPanel } from '../features/catalogue/OfferComponentsPanel'
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
  const [singleOffer, setSingleOffer] = useState<ProductVariant | null>(null)
  const [draft, setDraft] = useState(EMPTY_VARIANT)
  const [conversionTitle, setConversionTitle] = useState('')
  const [showConversion, setShowConversion] = useState(false)
  const [allCategories, setAllCategories] = useState<Category[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const [photoDropTarget, setPhotoDropTarget] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const draggedPhoto = useRef<string | null>(null)
  const { message, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()

  const apply = useCallback((next: ProductDetail) => {
    setDetail(next)
    setSingleOffer(next.defaultOffer)
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
      async () => {
        const sales = detail?.salesMode === 'single' && singleOffer
          ? {
              sku: singleOffer.sku,
              price: singleOffer.price,
              stock: singleOffer.stock,
              enabled: singleOffer.enabled,
            }
          : {}
        apply(await apiJson<ProductDetail>(`/api/products/${encodeURIComponent(id)}`, 'PUT', { ...form, ...sales, categoryIds: chosen }))
      },
      '商品已儲存。',
    )
  }

  function convertToMulti(event: Event) {
    event.preventDefault()
    void run(async () => {
      const next = await apiJson<ProductDetail>(
        `/api/products/${encodeURIComponent(id)}/offers/convert-to-multi`,
        'POST',
        { title: conversionTitle.trim() },
      )
      setConversionTitle('')
      setShowConversion(false)
      apply(next)
    }, '已改為多方案商品。')
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

  function reorderPhoto(imageId: string, targetPosition: number) {
    if (busy || detail === null) return
    const sourcePosition = detail.images.findIndex((image) => image.id === imageId)
    if (sourcePosition < 0 || sourcePosition === targetPosition) return

    const previousImages = detail.images
    const reordered = [...previousImages]
    const [moved] = reordered.splice(sourcePosition, 1)
    if (!moved) return
    reordered.splice(targetPosition, 0, moved)
    const positioned = reordered.map((image, position) => ({ ...image, position }))
    setDetail({ ...detail, images: positioned })

    void run(async () => {
      try {
        const next = await apiJson<ProductDetail>(
          `/api/products/${encodeURIComponent(id)}/images/order`,
          'PUT',
          { ids: positioned.map((image) => image.id) },
        )
        // Reordering photos must not discard unsaved product fields.
        setDetail(next)
      } catch (error) {
        setDetail((current) => current ? { ...current, images: previousImages } : current)
        throw error
      }
    }, '照片順序已更新。')
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
    (detail.salesMode === 'single' && singleOffer !== null && (
      singleOffer.sku !== detail.defaultOffer?.sku ||
      singleOffer.price !== detail.defaultOffer?.price ||
      singleOffer.stock !== detail.defaultOffer?.stock ||
      singleOffer.enabled !== detail.defaultOffer?.enabled
    )) ||
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

      {!sellable && detail.product.status === 'active' && (
        <p class="notice warn">這個商品已上架，但沒有任何啟用的規格，顧客看得到卻買不了。</p>
      )}

      <div class="product-edit-layout">
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

        <Panel title={detail.salesMode === 'single' ? '銷售資訊' : '方案與庫存'} class="product-variants-panel">
          {detail.salesMode === 'single' && singleOffer ? (
            <>
              <p class="muted">此商品目前沒有顧客需選擇的規格；售價、庫存與貨號由單一銷售方案提供。</p>
              <div class="ui-inline-form product-variant-create">
                <TextField
                  label="貨號"
                  hint="選填"
                  value={singleOffer.sku}
                  maxLength={40}
                  onInput={(event) => setSingleOffer({ ...singleOffer, sku: (event.currentTarget as HTMLInputElement).value })}
                />
                <TextField
                  label="售價"
                  type="number"
                  min={1}
                  max={PRODUCT_VARIANT_PRICE_MAX}
                  step={1}
                  value={singleOffer.price}
                  onInput={(event) => setSingleOffer({ ...singleOffer, price: Number.parseInt((event.currentTarget as HTMLInputElement).value, 10) })}
                />
                <TextField
                  label="庫存"
                  type="number"
                  min={0}
                  max={PRODUCT_VARIANT_STOCK_MAX}
                  step={1}
                  value={singleOffer.stock}
                  onInput={(event) => setSingleOffer({ ...singleOffer, stock: Number.parseInt((event.currentTarget as HTMLInputElement).value, 10) })}
                />
                <Toggle label="啟用" checked={singleOffer.enabled} onChange={(enabled) => setSingleOffer({ ...singleOffer, enabled })} />
              </div>
              {showConversion ? (
                <form class="ui-inline-form product-variant-create" onSubmit={convertToMulti}>
                  <p class="muted">目前的售價、庫存與貨號會保留在第一個方案，只需要命名它。</p>
                  <TextField
                    label="第一個方案名稱"
                    placeholder="例如 標準版"
                    value={conversionTitle}
                    maxLength={60}
                    required
                    onInput={(event) => setConversionTitle((event.currentTarget as HTMLInputElement).value)}
                  />
                  <Button type="submit" tone="primary" busy={busy} disabled={conversionTitle.trim() === ''}>
                    確認改為多方案
                  </Button>
                  <Button type="button" disabled={busy} onClick={() => setShowConversion(false)}>
                    取消
                  </Button>
                </form>
              ) : (
                <Button disabled={busy} onClick={() => setShowConversion(true)}>新增規格選項</Button>
              )}
            </>
          ) : (
            <>
              {detail.variants.length === 0 ? (
                <EmptyState title="還沒有銷售方案" body="至少要有一個啟用的方案，商品才有價格、才能被買走。" />
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
                        onChange={(event) => saveVariant(variant, { price: Number.parseInt((event.currentTarget as HTMLInputElement).value, 10) })}
                      />
                      <TextField
                        label="庫存"
                        type="number"
                        min={0}
                        max={PRODUCT_VARIANT_STOCK_MAX}
                        step={1}
                        value={variant.stock}
                        onChange={(event) => saveVariant(variant, { stock: Number.parseInt((event.currentTarget as HTMLInputElement).value, 10) })}
                      />
                      <Toggle label="啟用" checked={variant.enabled} onChange={(enabled) => saveVariant(variant, { enabled })} />
                      <Menu label={`「${variant.title}」的動作`}>
                        <MenuItem tone="danger" disabled={busy} onClick={() => void removeVariant(variant)}>
                          刪除方案
                        </MenuItem>
                      </Menu>
                    </li>
                  ))}
                </ul>
              )}

              <form class="ui-inline-form product-variant-create" onSubmit={addVariant}>
                <TextField label="方案名稱" placeholder="例如 M／藍" value={draft.title} maxLength={60} required onInput={(event) => setDraft({ ...draft, title: (event.currentTarget as HTMLInputElement).value })} />
                <TextField label="貨號" hint="選填" value={draft.sku} maxLength={40} onInput={(event) => setDraft({ ...draft, sku: (event.currentTarget as HTMLInputElement).value })} />
                <TextField label="售價" type="number" min={1} max={PRODUCT_VARIANT_PRICE_MAX} step={1} value={draft.price} required onInput={(event) => setDraft({ ...draft, price: (event.currentTarget as HTMLInputElement).value })} />
                <TextField label="庫存" type="number" min={0} max={PRODUCT_VARIANT_STOCK_MAX} step={1} value={draft.stock} required onInput={(event) => setDraft({ ...draft, stock: (event.currentTarget as HTMLInputElement).value })} />
                <Button type="submit" tone="primary" busy={busy}>新增方案</Button>
              </form>
            </>
          )}
        </Panel>
      </div>

      {/* One panel per offer: "online only" and "with materials" deliver
          different things, which is the whole point of having two offers. */}
      {detail.variants.map((variant) => (
        <div key={variant.id} class="offer-components-section">
          {detail.salesMode === 'multi' && (
            <p class="muted offer-components-for">方案：{variant.title}</p>
          )}
          <OfferComponentsPanel offerId={variant.id} />
        </div>
      ))}

      <Panel title="照片" class="product-photos-panel">
        <p class="muted">
          拖曳照片可以換順序，第一張是列表上的封面。最多 {MAX_IMAGES} 張，每張 3 MB 以內。
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
              <li
                key={image.id}
                class={photoDropTarget === image.id ? 'is-drop-target' : ''}
                draggable={!busy && detail.images.length > 1}
                onDragStart={(event) => {
                  draggedPhoto.current = image.id
                  if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', image.id)
                  }
                }}
                onDragOver={(event) => {
                  if (!draggedPhoto.current || draggedPhoto.current === image.id) return
                  event.preventDefault()
                  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
                  setPhotoDropTarget(image.id)
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setPhotoDropTarget((current) => current === image.id ? null : current)
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const draggedId = draggedPhoto.current || event.dataTransfer?.getData('text/plain')
                  draggedPhoto.current = null
                  setPhotoDropTarget(null)
                  if (draggedId) reorderPhoto(draggedId, position)
                }}
                onDragEnd={() => {
                  draggedPhoto.current = null
                  setPhotoDropTarget(null)
                }}
              >
                <span class="photo-drag-handle" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <circle cx="8" cy="6" r="1" />
                    <circle cx="16" cy="6" r="1" />
                    <circle cx="8" cy="12" r="1" />
                    <circle cx="16" cy="12" r="1" />
                    <circle cx="8" cy="18" r="1" />
                    <circle cx="16" cy="18" r="1" />
                  </svg>
                </span>
                <span class={position === 0 ? 'photo-position is-cover' : 'photo-position'}>
                  {position === 0 ? '封面' : position + 1}
                </span>
                {image.path && (
                  <img
                    src={apiUrl(image.path)}
                    alt={image.alt}
                    onClick={() => image.path && setLightbox({ src: apiUrl(image.path), alt: image.alt })}
                  />
                )}
                <div class="photo-actions">
                  <IconButton
                    label="向前移動照片"
                    size="sm"
                    disabled={busy || position === 0}
                    onClick={() => reorderPhoto(image.id, position - 1)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </IconButton>
                  <IconButton
                    label="向後移動照片"
                    size="sm"
                    disabled={busy || position === detail.images.length - 1}
                    onClick={() => reorderPhoto(image.id, position + 1)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </IconButton>
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
                </div>
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
