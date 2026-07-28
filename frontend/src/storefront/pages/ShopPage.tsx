import { useEffect, useState } from 'preact/hooks'

import { CartLink } from '../components/CartLink'
import { api, apiUrl } from '../../shared/api'
import type { PublicCategory, PublicProductCard } from '../../shared/types'
import '../styles/shop.css'

function priceLabel(card: PublicProductCard): string {
  if (card.priceFrom === null || card.priceTo === null) return '暫不販售'
  if (card.priceFrom === card.priceTo) return `NT$${card.priceFrom}`
  return `NT$${card.priceFrom} 起`
}

export function ShopPage() {
  const [products, setProducts] = useState<PublicProductCard[] | null>(null)
  const [categories, setCategories] = useState<PublicCategory[]>([])
  const [failed, setFailed] = useState(false)

  useEffect(() => {
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
      <header class="shop-head">
        <a class="brand" href="/">
          <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
        </a>
        <h1>商品</h1>
        <CartLink />
      </header>

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
        <p class="empty">載入中…</p>
      ) : products.length === 0 ? (
        <p class="empty">目前沒有販售中的商品。</p>
      ) : (
        <ul class="product-grid">
          {products.map((card) => (
            <li key={card.slug} class={card.inStock ? 'card' : 'card sold-out'}>
              <a href={`/shop/${encodeURIComponent(card.slug)}`}>
                <div class="cover">
                  {card.coverPath ? <img src={apiUrl(card.coverPath)} alt="" loading="lazy" /> : <span />}
                  {!card.inStock && <span class="ribbon">售完</span>}
                </div>
                <h2>{card.title}</h2>
                <p class="price">{priceLabel(card)}</p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
