import { useEffect, useState } from 'preact/hooks'

import { ApiError, api } from '../../shared/api'
import type { Order, OrderStatus } from '../../shared/types'
import '../styles/shop.css'

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '等待付款',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已逾期',
}

function orderDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function OrdersPage() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api<{ orders: Order[] }>('/api/orders')
      .then((data) => setOrders(data.orders))
      .catch((error) => {
        // An unauthenticated caller has already been sent to Google by the
        // api client; anything else is worth saying out loud.
        if (!(error instanceof ApiError && error.status === 401)) setFailed(true)
      })
  }, [])

  if (failed) return <main class="orders"><p class="empty">訂單載入失敗，請稍後再試。</p></main>
  if (orders === null) return <main class="orders"><p class="empty">載入中…</p></main>

  return (
    <main class="orders">
      <p class="crumb">
        <a href="/shop">← 商品列表</a>
      </p>
      <h1>我的訂單</h1>

      {orders.length === 0 ? (
        <p class="empty">
          還沒有任何訂單。<a href="/shop">去看看商品</a>
        </p>
      ) : (
        <ul class="order-list">
          {orders.map((order) => (
            <li key={order.id}>
              <a href={`/orders/${encodeURIComponent(order.id)}`}>
                <span class="id">{order.id}</span>
                <span class="date">{orderDate(order.createdAt)}</span>
                <span class={`status ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                <span class="money">NT${order.total}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
