import { useCallback, useEffect, useState } from 'preact/hooks'

import { ApiError, api, apiUrl } from '../../shared/api'
import { Confetti } from '../../shared/components/Confetti'
import type { OrderStatus, OrderDetail } from '../../shared/types'
import { ORDER_STATUS_LABELS } from '../../shared/presentation/order-status'
import '../styles/shop.css'
import { dateTime } from '../../shared/dates'

/**
 * The road an order travels, and how far along it is.
 *
 * Only the happy path is a rail. Cancelled and expired leave it rather than
 * continuing to a further step, so those two get a plain notice instead: a
 * greyed-out track implies the order is still on its way somewhere.
 */
const STEPS: { label: string; reached: OrderStatus[] }[] = [
  { label: '訂單已成立', reached: ['pending', 'paid', 'shipped', 'completed'] },
  { label: '訂單已付款', reached: ['paid', 'shipped', 'completed'] },
  { label: '訂單已出貨', reached: ['shipped', 'completed'] },
  { label: '已完成', reached: ['completed'] },
]

function minutesLeft(reservedUntil: number | null): number | null {
  if (reservedUntil === null) return null
  return Math.max(0, Math.ceil((reservedUntil * 1000 - Date.now()) / 60000))
}

export function OrderPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [celebrate] = useState(() => {
    const params = new URLSearchParams(location.search)
    if (params.has('placed')) {
      history.replaceState(null, '', location.pathname)
      return true
    }
    return false
  })

  const load = useCallback(async () => {
    try {
      const data = await api<OrderDetail>(`/api/orders/${encodeURIComponent(id)}`)
      setDetail(data)
      document.title = `訂單 ${id.slice(0, 8)} | Luma Studio`
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setMissing(true)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  async function fakePay() {
    setBusy(true)
    setNote(null)
    try {
      await api(`/api/orders/${encodeURIComponent(id)}/fake-payment`, { method: 'POST' })
      await load()
    } catch (error) {
      // 404 is the ordinary answer in production: the route only exists where
      // a deployment has explicitly switched it on.
      setNote(
        error instanceof ApiError && error.status === 404
          ? '這個環境沒有開啟測試付款。'
          : error instanceof Error
            ? error.message
            : '測試付款失敗。',
      )
    } finally {
      setBusy(false)
    }
  }

  if (missing) {
    return (
      <main class="order">
        <p class="empty">找不到這筆訂單。</p>
        <p>
          <a class="inline-action" href="/orders">查看我的訂單</a>
        </p>
      </main>
    )
  }

  if (detail === null) return (
    <main class="order">
      <div class="skeleton" style={{ height: '1.4rem', width: '40%', marginBottom: '1rem' }} />
      <div class="skeleton" style={{ height: '3rem', width: '100%', marginBottom: '1rem' }} />
      <div class="skeleton" style={{ height: '4rem', width: '100%' }} />
    </main>
  )

  const { order, items } = detail
  // An older response has no fulfilments. Reading them as none keeps a page
  // saved or cached before this shipped from throwing.
  const fulfillments = detail.fulfillments ?? []
  const courses = fulfillments.filter((entry) => entry.type === 'course')
  const kits = fulfillments.filter((entry) => entry.type === 'inventory')
  const remaining = order.status === 'pending' ? minutesLeft(order.reservedUntil) : null
  const closed = order.status === 'cancelled' || order.status === 'expired'

  return (
    <main class="order">
      <Confetti active={celebrate} />
      <div class="order-bar">
        <a class="back" href="/orders">
          ← 我的訂單
        </a>
        <span class="order-id">訂單編號 {order.id}</span>
        <span class={`status ${order.status}`}>{order.status === 'paid' ? '已付款，準備出貨' : ORDER_STATUS_LABELS[order.status]}</span>
      </div>

      <section class="panel">
        {closed ? (
          <p class="closed-note">這筆訂單{order.status === 'cancelled' ? '已取消' : '已逾期'}，庫存已經放回架上。</p>
        ) : (
          <ol class="progress">
            {STEPS.map((step) => (
              <li key={step.label} class={step.reached.includes(order.status) ? 'done' : ''}>
                <span class="dot" aria-hidden="true" />
                <span class="step-label">{step.label}</span>
              </li>
            ))}
          </ol>
        )}

        {order.status === 'pending' && (
          <div class="pay-panel">
            <p>
              這筆訂單還沒付款。
              {remaining !== null && remaining > 0 ? `庫存為你保留 ${remaining} 分鐘。` : '保留時間已過，庫存可能已經釋出。'}
            </p>
            <p class="hint">金流尚未串接，以下按鈕只是用來測試整個流程。</p>
            <button type="button" onClick={fakePay} disabled={busy}>
              {busy ? '處理中…' : '模擬付款（測試用）'}
            </button>
            {note && <p class="failed">{note}</p>}
          </div>
        )}
      </section>

      {/* An order with nothing to post has no recipient details worth showing.
          A card of empty fields reads as data that went missing. */}
      {fulfillments.some((entry) => entry.type === 'inventory') && (
      <section class="panel delivery-detail">
        <h2>收件資料</h2>
        <div class="recipient">
          <p class="who">{order.recipientName}</p>
          <p>{order.recipientPhone}</p>
          <p>{order.recipientEmail}</p>
          {order.shippingAddress && <p>{order.shippingAddress}</p>}
          {order.storeName && (
            <p>
              {order.storeName}
              {order.storeAddr && <small>{order.storeAddr}</small>}
            </p>
          )}
        </div>
      </section>
      )}

      {courses.length > 0 && (
        <section class="panel order-digital">
          <h2>數位內容</h2>
          <ul class="order-fulfillments">
            {courses.map((entry) => (
              <li key={entry.id}>
                <span class="what">
                  <span class="title">{entry.targetTitle}</span>
                  <small>
                    {entry.accessDays === null ? '永久觀看' : `觀看後 ${entry.accessDays} 天內有效`}
                  </small>
                </span>
                {/* "Ready" rather than "sent": a course is available the
                    moment payment lands, and saying "shipped" would have
                    somebody waiting by the door. */}
                <span class="state">{entry.status === 'fulfilled' ? '已開通' : '處理中'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {kits.length > 0 && (
        <section class="panel order-physical">
          <h2>待出貨內容</h2>
          <ul class="order-fulfillments">
            {kits.map((entry) => (
              <li key={entry.id}>
                <span class="what">
                  <span class="title">{entry.targetTitle}</span>
                  <small>×{entry.quantity}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="panel">
        <ul class="order-items">
          {items.map((item, index) => (
            // Keyed by position: the same product may appear twice under two
            // different variants.
            <li key={index}>
              <span class="thumb">
                {item.coverPath ? <img src={apiUrl(item.coverPath)} alt="" loading="lazy" /> : <span />}
              </span>
              <span class="what">
                {/* Only linked while the product is still listed. A dead link
                    on a receipt is worse than plain text. */}
                {item.slug ? (
                  <a class="title" href={`/shop/${encodeURIComponent(item.slug)}`}>
                    {item.productTitle}
                  </a>
                ) : (
                  <span class="title">{item.productTitle}</span>
                )}
                {item.variantTitle !== '' && <small>規格：{item.variantTitle}</small>}
                <small>×{item.quantity}</small>
              </span>
              <span class="money">NT${item.subtotal}</span>
            </li>
          ))}
        </ul>

        <dl class="totals">
          <div>
            <dt>商品小計</dt>
            <dd>NT${order.subtotal}</dd>
          </div>
          {kits.length > 0 && (
            <div>
              <dt>運費</dt>
              <dd>{order.shippingFee === 0 ? '免運' : `NT$${order.shippingFee}`}</dd>
            </div>
          )}
          <div class="grand">
            <dt>訂單金額</dt>
            <dd>NT${order.total}</dd>
          </div>
        </dl>

        <p class="placed-at">成立時間：{dateTime(order.createdAt)}</p>
      </section>
    </main>
  )
}
