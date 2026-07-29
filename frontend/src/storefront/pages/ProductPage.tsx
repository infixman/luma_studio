import { useContext, useEffect, useState } from 'preact/hooks'

import { ApiError, api, apiUrl } from '../../shared/api'
import { money, priceLabel } from '../../shared/money'
import type { PublicProductDetail, PublicVariant } from '../../shared/types'
import * as cart from '../lib/cart'
import { track } from '../lib/activity'
import { CustomerContext } from '../components/Chrome'
import '../styles/shop.css'

/** What the visitor is told about a variant's supply, if anything. */
function stockNote(variant: PublicVariant): string | null {
  if (!variant.inStock) return '售完'
  if (variant.stockLeft !== null) return `剩 ${variant.stockLeft} 件`
  return null
}

/**
 * The headline price: one number once a variant is picked, a range before.
 *
 * Shown large and on its own line, because it is the one thing on this page
 * somebody scrolled here to find.
 */
function headlinePrice(product: PublicProductDetail, chosen: PublicVariant | null): string {
  if (chosen) return money(chosen.price)
  const prices = product.variants.map((variant) => variant.price)
  if (prices.length === 0) return '暫不販售'
  // Same wording as the cards that led here. This page used to spell a range
  // out in full, so a product read `NT$300 起` on /shop and `NT$300 – NT$500`
  // one click later.
  return priceLabel(Math.min(...prices), Math.max(...prices))
}

export function productReturnTarget(search: string): { href: string; label: string } {
  const from = new URLSearchParams(search).get('from')

  // `from` is only ever emitted by a page-embedded shop row. Still validate
  // it here: a product URL is public, so it must not become an open redirect.
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/\\')) {
    return { href: '/shop', label: '商品列表' }
  }

  return { href: from, label: '上一頁' }
}

/** A one-Offer product must not make the visitor select an invisible option. */
export function initialOfferId(product: PublicProductDetail): string | null {
  return product.requiresOfferSelection ? null : product.variants[0]?.id ?? null
}

export function showOfferChooser(product: PublicProductDetail): boolean {
  return product.requiresOfferSelection && product.variants.length > 0
}

export function offerPurchaseState(product: PublicProductDetail, chosen: PublicVariant | null): 'choose' | 'soldout' | 'ready' {
  if (product.variants.length === 0 || chosen === null) return 'choose'
  return chosen.inStock ? 'ready' : 'soldout'
}

export function ProductPage({ slug }: { slug: string }) {
  const customer = useContext(CustomerContext)
  const [product, setProduct] = useState<PublicProductDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [shown, setShown] = useState(0)
  const [wanted, setWanted] = useState(1)
  const [added, setAdded] = useState<string | null>(null)

  useEffect(() => {
    api<PublicProductDetail>(`/api/products/${encodeURIComponent(slug)}`)
      .then((data) => {
        setProduct(data)
        document.title = `${data.title} | Luma Studio`
        setChosen(initialOfferId(data))
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) setMissing(true)
        else setFailed(true)
      })
  }, [slug])

  useEffect(() => {
    if (customer && product) {
      track({
        type: 'product_view',
        path: location.pathname,
        productSlug: product.slug,
        productTitle: product.title,
      })
    }
  }, [customer, product])

  if (missing) {
    return (
      <main class="product">
        <p class="empty">找不到這個商品，它可能已經下架。</p>
        <p>
          <a class="inline-action" href="/shop">回到商品列表</a>
        </p>
      </main>
    )
  }

  if (failed) return <main class="product"><p class="empty">商品載入失敗，請稍後再試一次。</p></main>
  if (product === null) return (
    <main class="product">
      <div class="layout">
        <div class="gallery">
          <div class="cover skeleton" />
        </div>
        <div class="info">
          <div class="skeleton" style={{ height: '1.6rem', width: '60%', marginBottom: '0.8rem' }} />
          <div class="skeleton" style={{ height: '1.2rem', width: '30%', marginBottom: '1.5rem' }} />
          <div class="skeleton" style={{ height: '2.5rem', width: '100%', marginBottom: '0.8rem' }} />
          <div class="skeleton" style={{ height: '2.8rem', width: '100%' }} />
        </div>
      </div>
    </main>
  )

  function addToCart() {
    if (!chosen || !product) return
    if (customer?.cartBlocked) {
      setAdded('這個帳號目前無法使用購物車，請與我們聯絡。')
      return
    }
    if (!cart.add(chosen, wanted)) {
      setAdded(`購物車最多放 ${cart.MAX_LINES} 種商品，先結帳或移除一些再加。`)
      return
    }
    if (customer) {
      track({
        type: 'cart_add',
        path: location.pathname,
        productSlug: product.slug,
        productTitle: product.title,
        quantity: wanted,
      })
    }
    setAdded(`已加入 ${wanted} 件。`)
  }

  /** Picking a different variant starts the quantity over: its shelf is a different shelf. */
  function choose(id: string) {
    setChosen(id)
    setWanted(1)
    setAdded(null)
  }

  const images = product.images.filter((image) => image.path)
  const cover = images[Math.min(shown, images.length - 1)]
  const picked = product.variants.find((variant) => variant.id === chosen) ?? null
  const needsOfferChoice = showOfferChooser(product)
  const purchaseState = offerPurchaseState(product, picked)
  const back = productReturnTarget(location.search)
  // Only the server knows the real ceiling; this one exists so the stepper
  // stops somewhere sensible when the shop has said how many are left.
  const ceiling = picked?.stockLeft ?? cart.MAX_QUANTITY

  return (
    <main class="product">
      <p class="crumb product-back">
        <a href={back.href} aria-label={`返回${back.label}`}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          <span>{back.label}</span>
        </a>
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

          <p class="headline-price">{headlinePrice(product, picked)}</p>

          {product.variants.length === 0 ? (
            <p class="empty">這個商品目前沒有可販售的規格。</p>
          ) : needsOfferChoice ? (
            <div class="chooser">
              <span class="chooser-label">方案</span>
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
                        onClick={() => choose(variant.id)}
                      >
                        <span class="name">{variant.title}</span>
                        <span class="price">NT${variant.price}</span>
                        {note && <span class={variant.inStock ? 'note low' : 'note out'}>{note}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : !picked?.inStock ? (
            <p class="notice warn">此商品目前售完。</p>
          ) : null}

          {product.variants.length > 0 && (
            <>
              <div class="chooser">
                <span class="chooser-label">數量</span>
                <div class="stepper">
                  <button
                    type="button"
                    aria-label="減一"
                    disabled={purchaseState !== 'ready' || wanted <= 1}
                    onClick={() => setWanted(Math.max(1, wanted - 1))}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={ceiling}
                    value={wanted}
                    disabled={!picked}
                    aria-label="數量"
                    onInput={(event) => {
                      const typed = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10)
                      setWanted(Number.isNaN(typed) ? 1 : Math.min(Math.max(1, typed), ceiling))
                    }}
                  />
                  <button
                    type="button"
                    aria-label="加一"
                    disabled={purchaseState !== 'ready' || wanted >= ceiling}
                    onClick={() => setWanted(Math.min(ceiling, wanted + 1))}
                  >
                    +
                  </button>
                </div>
                {picked !== null && picked.stockLeft !== null && <span class="left">剩 {picked.stockLeft} 件</span>}
              </div>

              <div class="buy">
                <button type="button" class="add" disabled={purchaseState !== 'ready'} onClick={addToCart}>
                  {purchaseState === 'choose' ? '請先選擇方案' : purchaseState === 'soldout' ? '已售完' : '加入購物車'}
                </button>
                {added && (
                  <p class="added" aria-live="polite">
                    {added} <a href="/cart">查看購物車</a>
                  </p>
                )}
              </div>
            </>
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
        </div>
      </div>

      {/* Its own panel below the fold, the way every shop the customer has
          used arranges it: the buying decision is above, the reading is here. */}
      {product.description && (
        <section class="description">
          <h2>商品描述</h2>
          {/<[a-z][\s\S]*>/i.test(product.description) ? (
            <div dangerouslySetInnerHTML={{ __html: product.description }} />
          ) : (
            product.description.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))
          )}
        </section>
      )}
    </main>
  )
}
