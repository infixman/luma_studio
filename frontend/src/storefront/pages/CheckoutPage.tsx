import { useCallback, useEffect, useState } from 'preact/hooks'

import { ApiError, api, apiJson, loginUrl } from '../../shared/api'
import type { CartQuote, Customer, OrderDetail } from '../../shared/types'
import { EMPTY_CART_QUOTE } from '../../shared/contracts/cart'
import * as cart from '../lib/cart'
import '../styles/shop.css'

/**
 * One page, not a wizard.
 *
 * At this basket size a three-step flow is three chances to leave. Everything
 * needed to place the order is here, and the totals come from the same
 * endpoint the cart used so the number cannot change on the way.
 */
export function CheckoutPage() {
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [quote, setQuote] = useState<CartQuote | null>(null)
  const [method, setMethod] = useState<string | null>(null)
  const [form, setForm] = useState({ recipientName: '', recipientPhone: '', address: '', recipientEmail: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const session = await api<{ customer: Customer }>('/api/session')
      setCustomer(session.customer)
      setForm((current) => ({
        recipientName: current.recipientName || session.customer.recipientName,
        recipientPhone: current.recipientPhone || session.customer.recipientPhone,
        address: current.address || session.customer.address,
        recipientEmail: current.recipientEmail || session.customer.email,
      }))
    } catch (thrown) {
      // The api client already sends an unauthenticated caller to Google.
      if (!(thrown instanceof ApiError && thrown.status === 401)) setError('無法確認登入狀態，請重新整理。')
      return
    }

    const lines = cart.read()
    if (lines.length === 0) {
      setQuote(EMPTY_CART_QUOTE)
      return
    }
    try {
      const next = await apiJson<CartQuote>('/api/cart/validate', 'POST', { lines })
      setQuote(next)
      setMethod((current) => current ?? next.shipping[0]?.method ?? null)
    } catch {
      setError('購物車載入失敗，請稍後再試。')
    }
  }, [])

  useEffect(() => {
    document.title = '結帳 | Luma Studio'
    void load()
  }, [load])

  async function placeOrder(event: Event) {
    event.preventDefault()
    if (busy || !method) return
    setBusy(true)
    setError(null)
    try {
      const placed = await apiJson<OrderDetail>('/api/checkout', 'POST', {
        lines: cart.read(),
        shippingMethod: method,
        ...form,
      })
      // Only once the order exists. Clearing earlier would lose the basket
      // for anyone whose payment details were refused a second later.
      cart.clear()
      location.assign(`/orders/${encodeURIComponent(placed.order.id)}?placed=1`)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : '結帳失敗，請再試一次。')
      setBusy(false)
    }
  }

  if (error && !customer) {
    return (
      <main class="checkout">
        <p class="empty">{error}</p>
        <p>
          <a class="inline-action" href={loginUrl(`${location.origin}/checkout`)}>重新登入</a>
        </p>
      </main>
    )
  }

  if (quote === null) return (
    <main class="checkout">
      <div class="skeleton" style={{ height: '1.4rem', width: '30%', marginBottom: '1rem' }} />
      <div class="skeleton" style={{ height: '3.5rem', width: '100%', marginBottom: '0.8rem' }} />
      <div class="skeleton" style={{ height: '3.5rem', width: '100%', marginBottom: '1.5rem' }} />
      <div class="skeleton" style={{ height: '2.8rem', width: '50%' }} />
    </main>
  )

  if (quote.lines.length === 0) {
    return (
      <main class="checkout">
        <p class="empty">
          購物車是空的。<a class="inline-action" href="/shop">去看看商品</a>
        </p>
      </main>
    )
  }

  const delivery = quote.shipping.find((option) => option.method === method)
  const total = quote.subtotal + (delivery?.fee ?? 0)
  const needsAddress = method === 'home'

  return (
    <main class="checkout">
      <p class="crumb">
        <a href="/cart">← 回到購物車</a>
      </p>
      <h1>結帳</h1>

      {quote.problems.length > 0 && (
        <p class="notes">購物車內容有變動，請先回到購物車確認。</p>
      )}

      <form class="checkout-form" onSubmit={placeOrder}>
        <section>
          <h2>配送方式</h2>
          <ul class="delivery">
            {quote.shipping.map((option) => (
              <li key={option.method}>
                <label>
                  <input
                    type="radio"
                    name="delivery"
                    checked={option.method === method}
                    onChange={() => setMethod(option.method)}
                  />
                  <span class="label">{option.label}</span>
                  <span class="fee">{option.fee === 0 ? '免運' : `NT$${option.fee}`}</span>
                </label>
              </li>
            ))}
          </ul>
          {method === 'cvs_c2c' && <p class="hint">取貨門市會在下一步的付款頁面選擇。</p>}
        </section>

        <section>
          <h2>收件資料</h2>
          <label>
            收件人姓名
            <input
              value={form.recipientName}
              maxLength={25}
              required
              onInput={(event) => setForm({ ...form, recipientName: (event.target as HTMLInputElement).value })}
            />
            <small>超商取件時會核對，請填真實姓名，且不能包含表情符號。</small>
          </label>
          <label>
            手機號碼
            <input
              value={form.recipientPhone}
              inputMode="numeric"
              placeholder="09xxxxxxxx"
              required
              onInput={(event) => setForm({ ...form, recipientPhone: (event.target as HTMLInputElement).value })}
            />
          </label>
          <label>
            電子信箱
            <input
              type="email"
              value={form.recipientEmail}
              required
              onInput={(event) => setForm({ ...form, recipientEmail: (event.target as HTMLInputElement).value })}
            />
            <small>訂單通知會寄到這裡。</small>
          </label>
          {needsAddress && (
            <label>
              收件地址
              <input
                value={form.address}
                maxLength={200}
                required
                onInput={(event) => setForm({ ...form, address: (event.target as HTMLInputElement).value })}
              />
            </label>
          )}
        </section>

        <section class="summary">
          <h2>訂單金額</h2>
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
          {error && <p class="failed">{error}</p>}
          <button type="submit" class="place" disabled={busy || !method || quote.problems.length > 0}>
            {busy ? '處理中…' : '送出訂單'}
          </button>
          <p class="hint">送出後庫存會保留 15 分鐘。</p>
        </section>
      </form>
    </main>
  )
}
