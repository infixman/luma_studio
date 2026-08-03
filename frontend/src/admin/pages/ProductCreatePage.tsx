import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Button, Panel, Spinner, TextField, Toggle } from '../components/ui'
import {
  ProductFormFields,
  type ProductFormValue,
} from '../features/catalogue/ProductFormFields'
import { navigate } from '../lib/navigation'
import { api, apiJson } from '../../shared/api'
import type { Category, ProductDetail } from '../../shared/types'
import {
  PRODUCT_VARIANT_PRICE_MAX,
  PRODUCT_VARIANT_STOCK_MAX,
} from '../features/catalogue/constraints'
import '../styles/shop-admin.css'

const EMPTY_PRODUCT: ProductFormValue = {
  title: '',
  slug: '',
  description: '',
  status: 'draft',
}

const EMPTY_SALES = { sku: '', price: '', stock: '', enabled: true }

export function ProductCreatePage() {
  const [form, setForm] = useState<ProductFormValue>(EMPTY_PRODUCT)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [sales, setSales] = useState(EMPTY_SALES)
  const { message, showError, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      const listing = await api<{ categories: Category[] }>('/api/categories')
      setCategories(listing.categories)
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  async function create(event: Event) {
    event.preventDefault()
    const result = { id: '' }
    const ok = await run(async () => {
      const created = await apiJson<ProductDetail>('/api/products', 'POST', {
        ...form,
        title: form.title.trim(),
        slug: form.slug.trim(),
        categoryIds: chosen,
        sku: sales.sku.trim(),
        price: Number.parseInt(sales.price, 10),
        stock: Number.parseInt(sales.stock, 10),
        enabled: sales.enabled,
      })
      result.id = created.product.id
    }, '商品已建立。')

    if (ok && result.id) {
      navigate(`/products/${encodeURIComponent(result.id)}`)
    }
  }

  const complete =
    form.title.trim() !== '' &&
    form.slug.trim() !== '' &&
    sales.price !== '' &&
    sales.stock !== ''

  return (
    <AdminShell
      current="/products"
      title="新增商品"
      back={{ href: '/products', label: '回到商品清單' }}
      message={message}
      onError={showError}
      actions={
        <Button
          type="submit"
          form="product-create-form"
          tone="primary"
          busy={busy}
          disabled={!complete || categories === null}
        >
          新增商品
        </Button>
      }
    >
      <Panel title="商品資料" class="product-info-panel">
        {categories === null ? (
          <Spinner />
        ) : (
          <form id="product-create-form" class="product-editor-form" onSubmit={create}>
            <ProductFormFields
              value={form}
              categories={categories}
              chosen={chosen}
              onChange={setForm}
              onChosenChange={setChosen}
            />
          </form>
        )}
      </Panel>
      <Panel title="銷售資訊" class="product-variants-panel">
        <p class="muted">沒有規格的商品會建立一筆隱藏的單一銷售方案，顧客不需要再選一次。</p>
        <div class="ui-inline-form product-variant-create">
          <TextField
            label="貨號"
            hint="選填"
            value={sales.sku}
            maxLength={40}
            onInput={(event) => setSales({ ...sales, sku: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="售價"
            type="number"
            min={1}
            max={PRODUCT_VARIANT_PRICE_MAX}
            step={1}
            value={sales.price}
            required
            onInput={(event) => setSales({ ...sales, price: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="庫存"
            type="number"
            min={0}
            max={PRODUCT_VARIANT_STOCK_MAX}
            step={1}
            value={sales.stock}
            required
            onInput={(event) => setSales({ ...sales, stock: (event.currentTarget as HTMLInputElement).value })}
          />
          <Toggle label="啟用" checked={sales.enabled} onChange={(enabled) => setSales({ ...sales, enabled })} />
        </div>
      </Panel>
    </AdminShell>
  )
}
