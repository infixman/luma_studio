import { useCallback, useEffect, useState } from 'preact/hooks'

import { ApiError, api } from '../../shared/api'
import type { OrderDetail, OrderStatus } from '../../shared/types'
import '../styles/shop.css'

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '等待付款',
  paid: '已付款，準備出貨',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已逾期',
}

function minutesLeft(reservedUntil: number | null): number | null {
  if (reservedUntil === null) return null
  return Math.max(0, Math.ceil((reservedUntil * 1000 - Date.now()) / 60000))
}

export function OrderPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDetail(await api<OrderDetail>(`/api/orders/${encodeURIComponent(id)}`))
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
          <a href="/orders">查看我的訂單</a>
        </p>
      </main>
    )
  }

  if (detail === null) return <main class="order"><p class="empty">載入中…</p></main>

  const { order, items } = detail
  const remaining = order.status === 'pending' ? minutesLeft(order.reservedUntil) : null

  return (
    <main class="order">
      <p class="crumb">
        <a href="/orders">← 我的訂單</a>
      </p>
      <h1>訂單 {order.id}</h1>
      <p class={`status ${order.status}`}>{STATUS_LABELS[order.status]}</p>

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

      <ul class="order-items">
        {items.map((item, index) => (
          <li key={index}>
            <span class="what">
              {item.productTitle}
              <small>{item.variantTitle}</small>
            </span>
            <span class="qty">×{item.quantity}</span>
            <span class="money">NT${item.subtotal}</span>
          </li>
        ))}
      </ul>

      <dl class="totals">
        <div>
          <dt>小計</dt>
          <dd>NT${order.subtotal}</dd>
        </div>
        <div>
          <dt>運費</dt>
          <dd>{order.shippingFee === 0 ? '免運' : `NT$${order.shippingFee}`}</dd>
        </div>
        <div class="grand">
          <dt>總計</dt>
          <dd>NT${order.total}</dd>
        </div>
      </dl>

      <section class="delivery-detail">
        <h2>收件資料</h2>
        <p>{order.recipientName}</p>
        <p>{order.recipientPhone}</p>
        <p>{order.recipientEmail}</p>
        {order.shippingAddress && <p>{order.shippingAddress}</p>}
        {order.storeName && (
          <p>
            {order.storeName}
            {order.storeAddr && <small>{order.storeAddr}</small>}
          </p>
        )}
      </section>
    </main>
  )
}
