import { useCallback, useEffect, useState } from 'preact/hooks'

import { apiJson, apiUrl } from '../../shared/api'
import type { CartProblem, CartQuote } from '../../shared/types'
import * as cart from '../lib/cart'
import '../styles/shop.css'

function problemText(problem: CartProblem): string {
  if (problem.reason === 'unavailable') return `${problem.title ?? '有一項商品'}已經停售，已從購物車移除。`
  if (problem.reason === 'out_of_stock') return `${problem.title ?? '有一項商品'}目前缺貨，已從購物車移除。`
  return `${problem.title ?? '有一項商品'}只剩 ${problem.available} 件，數量已調整。`
}

export function CartPage() {
  const [quote, setQuote] = useState<CartQuote | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [failed, setFailed] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)

  const revalidate = useCallback(async () => {
    const lines = cart.read()
    if (lines.length === 0) {
      setQuote({ lines: [], problems: [], subtotal: 0, shipping: [] })
      setNotes([])
      return
    }
    try {
      const next = await apiJson<CartQuote>('/api/cart/validate', 'POST', { lines })
      setQuote(next)
      setNotes(next.problems.map(problemText))
      // Lines the server dropped are dropped here too, or they would come
      // back on every load and the same warning would appear forever.
      cart.forget(
        next.problems.filter((problem) => problem.reason !== 'reduced').map((problem) => problem.variantId),
      )
      for (const problem of next.problems) {
        if (problem.reason === 'reduced' && problem.available !== undefined) {
          cart.setQuantity(problem.variantId, problem.available)
        }
      }
      setChosen((current) => current ?? next.shipping[0]?.method ?? null)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void revalidate()
  }, [revalidate])

  function change(variantId: string, quantity: number) {
    cart.setQuantity(variantId, quantity)
    void revalidate()
  }

  function drop(variantId: string) {
    cart.remove(variantId)
    void revalidate()
  }

  if (failed) {
    return (
      <main class="cart">
        <p class="empty">購物車載入失敗，請稍後再試一次。</p>
      </main>
    )
  }

  if (quote === null) {
    return (
      <main class="cart">
        <p class="empty">載入中…</p>
      </main>
    )
  }

  const delivery = quote.shipping.find((option) => option.method === chosen) ?? quote.shipping[0]
  const total = quote.subtotal + (delivery?.fee ?? 0)

  return (
    <main class="cart">
      <h1>購物車</h1>

      {notes.length > 0 && (
        <ul class="notes">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}

      {quote.lines.length === 0 ? (
        <p class="empty">
          購物車是空的。<a href="/shop">去看看商品</a>
        </p>
      ) : (
        <>
          <div class="panel cart-panel">
            {/* Column headings, so the four numbers down the right are read as
                a table rather than four unrelated figures per row. Hidden on a
                narrow screen, where the rows stop being columns at all. */}
            <div class="cart-heads" aria-hidden="true">
              <span>商品</span>
              <span>單價</span>
              <span>數量</span>
              <span>小計</span>
              <span />
            </div>

            <ul class="cart-lines">
              {quote.lines.map((line) => (
                <li key={line.variantId}>
                  <div class="thumb">
                    {line.imagePath ? <img src={apiUrl(line.imagePath)} alt="" /> : <span />}
                  </div>
                  <div class="what">
                    <a href={`/shop/${encodeURIComponent(line.productSlug)}`}>{line.productTitle}</a>
                    <p class="variant">規格：{line.variantTitle}</p>
                    {line.stockLeft !== null && <p class="note low">剩 {line.stockLeft} 件</p>}
                  </div>
                  <p class="unit">NT${line.unitPrice}</p>
                  <label class="qty">
                    <span class="qty-label">數量</span>
                    <input
                      type="number"
                      min={1}
                      max={cart.MAX_QUANTITY}
                      step={1}
                      value={line.quantity}
                      onChange={(event) =>
                        change(line.variantId, Number.parseInt((event.target as HTMLInputElement).value, 10))
                      }
                    />
                  </label>
                  <p class="line-total">NT${line.lineTotal}</p>
                  <button type="button" class="drop" onClick={() => drop(line.variantId)}>
                    移除
                  </button>
                </li>
              ))}
            </ul>

            <p class="keep-shopping">
              <a href="/shop">← 繼續選購</a>
            </p>
          </div>

          <section class="panel summary">
            <h2>配送方式</h2>
            <ul class="delivery">
              {quote.shipping.map((option) => (
                <li key={option.method}>
                  <label>
                    <input
                      type="radio"
                      name="delivery"
                      checked={option.method === delivery?.method}
                      onChange={() => setChosen(option.method)}
                    />
                    <span class="label">{option.label}</span>
                    <span class="fee">{option.fee === 0 ? '免運' : `NT$${option.fee}`}</span>
                  </label>
                  {option.fee > 0 && option.freeThreshold !== null && (
                    <p class="hint">再買 NT${option.freeThreshold - quote.subtotal} 就免運</p>
                  )}
                </li>
              ))}
            </ul>

            <dl class="totals">
              <div>
                <dt>小計</dt>
                <dd>NT${quote.subtotal}</dd>
              </div>
              <div>
                <dt>運費</dt>
                <dd>{delivery ? (delivery.fee === 0 ? '免運' : `NT$${delivery.fee}`) : '—'}</dd>
              </div>
              <div class="grand">
                <dt>總計</dt>
                <dd>NT${total}</dd>
              </div>
            </dl>

            <a class="to-checkout" href="/checkout">
              前往結帳
            </a>
            <p class="pending">結帳需要以 Google 登入。</p>
          </section>
        </>
      )}
    </main>
  )
}
