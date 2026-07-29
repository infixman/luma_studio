import { useEffect, useState } from 'preact/hooks'

import { api } from '../../shared/api'
import type { PublicCategory, PublicProductCard } from '../../shared/types'
import { ProductGrid } from '../features/catalogue/ProductGrid'
import { ProductGridSkeleton } from '../features/catalogue/ProductGridSkeleton'
import '../styles/shop.css'

export function ShopPage() {
  const [products, setProducts] = useState<PublicProductCard[] | null>(null)
  const [categories, setCategories] = useState<PublicCategory[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    document.title = '商品 | Luma Studio'
    api<{ products: PublicProductCard[] }>('/api/products')
      .then((data) => setProducts(data.products))
      .catch(() => setFailed(true))
    // Its own request: an empty category list is not a reason to show no
    // products, so a failure here is silent.
    api<{ categories: PublicCategory[] }>('/api/categories')
      .then((data) => setCategories(data.categories.filter((category) => category.productCount > 0)))
      .catch(() => undefined)
  }, [])

  return (
    <main class="shop">
      {/* No logo and no cart link here: the site header carries both, on
          every page, and a second copy is what this page used to show. */}
      <h1 class="shop-title">商品</h1>

      {categories.length > 0 && (
        <ul class="category-chips">
          {categories.map((category) => (
            <li key={category.slug}>
              <a href={`/shop/c/${encodeURIComponent(category.slug)}`}>
                {category.title}
                <span class="count">{category.productCount}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {failed ? (
        <p class="empty">商品載入失敗，請稍後再試一次。</p>
      ) : products === null ? (
        <ProductGridSkeleton />
      ) : products.length === 0 ? (
        <p class="empty">目前沒有販售中的商品。</p>
      ) : (
        <ProductGrid products={products} />
      )}
    </main>
  )
}
