import { useEffect, useState } from 'preact/hooks'

import { ApiError, api, apiUrl } from '../../shared/api'
import type { PublicProductDetail, PublicVariant } from '../../shared/types'
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

  const images = product.images.filter((image) => image.path)
  const cover = images[Math.min(shown, images.length - 1)]

  return (
    <main class="product">
      <p class="crumb">
        <a href="/shop">← 商品列表</a>
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
