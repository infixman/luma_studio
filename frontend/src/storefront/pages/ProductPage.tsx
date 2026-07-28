import { useEffect, useState } from 'preact/hooks'

import { CartLink } from '../components/CartLink'
import { ApiError, api, apiUrl } from '../../shared/api'
import type { PublicProductDetail, PublicVariant } from '../../shared/types'
import * as cart from '../lib/cart'
import '../styles/shop.css'

/** What the visitor is told about a variant's supply, if anything. */
function stockNote(variant: PublicVariant): string | null {
  if (!variant.inStock) return '售完'
  if (variant.stockLeft !== null) return `剩 ${variant.stockLeft} 件`
  return null
}

export function ProductPage({ slug }: { slug: string }) {
  const [product, setProduct] = useState<PublicProductDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [shown, setShown] = useState(0)
  const [added, setAdded] = useState<string | null>(null)

  useEffect(() => {
    api<PublicProductDetail>(`/api/products/${encodeURIComponent(slug)}`)
      .then((data) => {
        setProduct(data)
        // Preselect when there is nothing to choose between: making someone
        // click the only option is a step that exists for the code's benefit.
        const available = data.variants.filter((variant) => variant.inStock)
        if (available.length === 1) setChosen(available[0]!.id)
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) setMissing(true)
        else setFailed(true)
      })
  }, [slug])

  if (missing) {
    return (
      <main class="product">
        <p class="empty">找不到這個商品，它可能已經下架。</p>
        <p>
          <a href="/shop">回到商品列表</a>
        </p>
      </main>
    )
  }

  if (failed) return <main class="product"><p class="empty">商品載入失敗，請稍後再試一次。</p></main>
  if (product === null) return <main class="product"><p class="empty">載入中…</p></main>

  function addToCart() {
    if (!chosen) return
    if (!cart.add(chosen, 1)) {
      setAdded(`購物車最多放 ${cart.MAX_LINES} 種商品，先結帳或移除一些再加。`)
      return
    }
    setAdded('已加入購物車。')
  }

  const images = product.images.filter((image) => image.path)
  const cover = images[Math.min(shown, images.length - 1)]

  return (
    <main class="product">
      <p class="crumb">
        <a href="/shop">← 商品列表</a>
        <CartLink />
      </p>

      <div class="layout">
        <div class="gallery">
          <div class="cover">{cover ? <img src={apiUrl(cover.path!)} alt={cover.alt} /> : <span />}</div>
          {images.length > 1 && (
            <ul class="thumbs">
              {images.map((image, index) => (
                <li key={image.path}>
                  <button
                    type="button"
                    class={index === shown ? 'current' : ''}
                    aria-label={`第 ${index + 1} 張照片`}
                    onClick={() => setShown(index)}
                  >
                    <img src={apiUrl(image.path!)} alt="" loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div class="info">
          <h1>{product.title}</h1>

          {product.variants.length === 0 ? (
            <p class="empty">這個商品目前沒有可販售的規格。</p>
          ) : (
            <ul class="variants">
              {product.variants.map((variant) => {
                const note = stockNote(variant)
                return (
                  <li key={variant.id}>
                    <button
                      type="button"
                      class={variant.id === chosen ? 'variant current' : 'variant'}
                      disabled={!variant.inStock}
                      aria-pressed={variant.id === chosen}
                      onClick={() => setChosen(variant.id)}
                    >
                      <span class="name">{variant.title}</span>
                      <span class="price">NT${variant.price}</span>
                      {note && <span class={variant.inStock ? 'note low' : 'note out'}>{note}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {product.variants.length > 0 && (
            <div class="buy">
              <button type="button" class="add" disabled={!chosen} onClick={addToCart}>
                {chosen ? '加入購物車' : '請先選擇規格'}
              </button>
              {added && (
                <p class="added" aria-live="polite">
                  {added} <a href="/cart">查看購物車</a>
                </p>
              )}
            </div>
          )}

          {product.categories.length > 0 && (
            <ul class="category-chips on-product">
              {product.categories.map((category) => (
                <li key={category.slug}>
                  <a href={`/shop/c/${encodeURIComponent(category.slug)}`}>{category.title}</a>
                </li>
              ))}
            </ul>
          )}

          {product.description && (
            <div class="description">
              {product.description.split(/\n{2,}/).map((paragraph, index) => (
                // Keyed by position: two identical paragraphs are legitimate
                // in a description, and the text itself would collide.
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
