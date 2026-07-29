import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Button, Panel, Spinner } from '../components/ui'
import {
  ProductFormFields,
  type ProductFormValue,
} from '../features/catalogue/ProductFormFields'
import { api, apiJson } from '../../shared/api'
import type { Category, ProductDetail } from '../../shared/types'
import '../styles/shop-admin.css'

const EMPTY_PRODUCT: ProductFormValue = {
  title: '',
  slug: '',
  description: '',
  status: 'draft',
}

export function ProductCreatePage() {
  const [form, setForm] = useState<ProductFormValue>(EMPTY_PRODUCT)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
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
      })
      result.id = created.product.id
    }, '商品已建立。')

    if (ok && result.id) {
      location.assign(`/products/${encodeURIComponent(result.id)}`)
    }
  }

  const complete = form.title.trim() !== '' && form.slug.trim() !== ''

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
    </AdminShell>
  )
}
