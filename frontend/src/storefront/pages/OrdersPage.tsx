import { useEffect, useState } from 'preact/hooks'

import { ApiError, api, apiUrl } from '../../shared/api'
import type { OrderCard, OrderStatus } from '../../shared/types'
import '../styles/shop.css'

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '等待付款',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已逾期',
}

/**
 * The tabs across the top, in the order an order moves through them.
 *
 * `null` is "全部" rather than a status of its own, so the filter is one
 * comparison instead of a special case at every use.
 *
 * 已取消 and 已逾期 share a tab: to the person reading it they are the same
 * news — it did not happen — and the difference is only in whose doing it was.
 */
const TABS: { key: string; label: string; matches: (status: OrderStatus) => boolean }[] = [
  { key: 'all', label: '全部', matches: () => true },
  { key: 'pending', label: '待付款', matches: (status) => status === 'pending' },
  { key: 'paid', label: '待出貨', matches: (status) => status === 'paid' },
  { key: 'shipped', label: '待收貨', matches: (status) => status === 'shipped' },
  { key: 'completed', label: '已完成', matches: (status) => status === 'completed' },
  { key: 'closed', label: '不成立', matches: (status) => status === 'cancelled' || status === 'expired' },
]

function orderDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function OrdersPage() {
  const [orders, setOrders] = useState<OrderCard[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState('all')

  useEffect(() => {
    api<{ orders: OrderCard[] }>('/api/orders')
      .then((data) => setOrders(data.orders))
      .catch((error) => {
        // An unauthenticated caller has already been sent to Google by the
        // api client; anything else is worth saying out loud.
        if (!(error instanceof ApiError && error.status === 401)) setFailed(true)
      })
  }, [])

  if (failed) return <main class="orders"><p class="empty">訂單載入失敗，請稍後再試。</p></main>
  if (orders === null) return <main class="orders"><p class="empty">載入中…</p></main>

  const current = TABS.find((entry) => entry.key === tab) ?? TABS[0]!
  const shown = orders.filter((order) => current.matches(order.status))

  return (
    <main class="orders">
      <h1>我的訂單</h1>

      {orders.length === 0 ? (
        <p class="empty">
          還沒有任何訂單。<a href="/shop">去看看商品</a>
        </p>
      ) : (
        <>
          {/* Counts sit on the tabs rather than being discovered by clicking:
              "which ones have I not paid for" is the question this page is
              usually opened to answer. */}
          <div class="status-tabs" role="tablist">
            {TABS.map((entry) => {
              const count = orders.filter((order) => entry.matches(order.status)).length
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  aria-selected={entry.key === tab}
                  class={entry.key === tab ? 'current' : ''}
                  onClick={() => setTab(entry.key)}
                >
                  {entry.label}
                  {count > 0 && entry.key !== 'all' && <span class="tab-count">({count})</span>}
                </button>
              )
            })}
          </div>

          {shown.length === 0 ? (
            <p class="empty">這個狀態沒有訂單。</p>
          ) : (
            <ul class="order-cards">
              {shown.map((order) => (
                <li key={order.id} class="order-card">
                  <div class="card-head">
                    <span class="id">{order.id}</span>
                    <span class="date">{orderDate(order.createdAt)}</span>
                    <span class={`status ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                  </div>

                  <a class="card-items" href={`/orders/${encodeURIComponent(order.id)}`}>
                    {order.items.map((item, index) => (
                      // Keyed by position: an order may legitimately hold the
                      // same product twice under different variants.
                      <span class="line" key={index}>
                        <span class="thumb">
                          {item.coverPath ? <img src={apiUrl(item.coverPath)} alt="" loading="lazy" /> : <span />}
                        </span>
                        <span class="what">
                          <span class="title">{item.productTitle}</span>
                          <small>規格：{item.variantTitle}</small>
                          <small>×{item.quantity}</small>
                        </span>
                        <span class="money">NT${item.subtotal}</span>
                      </span>
                    ))}
                  </a>

                  <div class="card-foot">
                    <span class="grand">
                      訂單金額：<strong>NT${order.total}</strong>
                    </span>
                    <a class="see" href={`/orders/${encodeURIComponent(order.id)}`}>
                      查看訂單
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  )
}
