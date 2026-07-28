import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { ApiError, api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { AdminOrder, AdminOrderDetail, AdminOrderList, OrderStatus } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/orders-admin.css'

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '等待付款',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已逾期',
}

const TABS: { value: OrderStatus | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'pending', label: '等待付款' },
  { value: 'paid', label: '已付款' },
  { value: 'shipped', label: '已出貨' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已逾期' },
]

/**
 * What the shop can do to an order from where it is now.
 *
 * The same table the API enforces. Drawing a button the server would refuse
 * teaches people that the buttons lie.
 */
const MOVES: Partial<Record<OrderStatus, { action: string; label: string; prompt?: string }[]>> = {
  pending: [
    { action: 'paid', label: '標記已付款', prompt: '對到哪一筆匯款？（會記進稽核紀錄）' },
    { action: 'cancel', label: '取消訂單', prompt: '取消原因' },
  ],
  paid: [
    { action: 'shipped', label: '標記已出貨', prompt: '物流單號或交寄方式（可留空）' },
    { action: 'cancel', label: '取消訂單', prompt: '取消原因' },
  ],
  shipped: [
    { action: 'completed', label: '標記已完成' },
    { action: 'cancel', label: '退貨並取消', prompt: '退貨原因' },
  ],
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function OrdersAdminPage() {
  const [list, setList] = useState<AdminOrderList | null>(null)
  const [status, setStatus] = useState<OrderStatus | ''>('')
  // Seeded from the URL, because the member page links here with the order
  // id in it. A link that lands on an unfiltered list is a link that lies.
  const [search, setSearch] = useState(new URLSearchParams(location.search).get('q') ?? '')
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const load = useCallback(async () => {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (search.trim()) query.set('q', search.trim())
    try {
      setList(await api<AdminOrderList>(`/api/orders${query.toString() ? `?${query}` : ''}`))
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [search, showError, status])

  useEffect(() => {
    void load()
  }, [load])

  async function run(work: () => Promise<void>, done: string) {
    if (busy) return
    setBusy(true)
    try {
      await work()
      show(done, 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  async function open(order: AdminOrder) {
    try {
      const next = await api<AdminOrderDetail>(`/api/orders/${encodeURIComponent(order.id)}`)
      setDetail(next)
      setNote(next.order.adminNote)
    } catch (error) {
      showError(error)
    }
  }

  function act(order: AdminOrder, move: { action: string; label: string; prompt?: string }) {
    let payload: Record<string, string> = {}
    if (move.prompt) {
      const answer = prompt(move.prompt, '')
      if (answer === null) return
      payload = move.action === 'cancel' ? { reason: answer } : { detail: answer }
    }
    if (move.action === 'cancel' && !confirm(`確定要取消 ${order.id}？庫存會退回。`)) return

    void run(async () => {
      const next = await apiJson<AdminOrderDetail>(
        `/api/orders/${encodeURIComponent(order.id)}/${move.action}`,
        'POST',
        payload,
      )
      setDetail(next)
      setNote(next.order.adminNote)
      await load()
    }, `${move.label}完成。`)
  }

  function saveNote(event: Event) {
    event.preventDefault()
    if (!detail) return
    void run(async () => {
      const next = await apiJson<AdminOrderDetail>(
        `/api/orders/${encodeURIComponent(detail.order.id)}/note`,
        'POST',
        { note },
      )
      setDetail(next)
      await load()
    }, '備註已儲存。')
  }

  const counts = list?.counts ?? {}

  return (
    <AdminShell current="/orders" message={message} onError={showError}>
      <section class="stack shop">
        <div class="card">
          <h2>訂單</h2>

          <div class="order-filters">
            <nav class="order-tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  class={tab.value === status ? 'current' : ''}
                  onClick={() => setStatus(tab.value)}
                >
                  {tab.label}
                  {tab.value && counts[tab.value] ? <span class="count">{counts[tab.value]}</span> : null}
                </button>
              ))}
            </nav>
            <input
              type="search"
              placeholder="訂單編號、收件人或 email"
              value={search}
              onInput={(event) => setSearch((event.target as HTMLInputElement).value)}
            />
          </div>

          {list === null ? (
            <p class="muted">載入中…</p>
          ) : list.orders.length === 0 ? (
            <p class="muted">沒有符合的訂單。</p>
          ) : (
            <table class="order-table">
              <thead>
                <tr>
                  <th>訂單</th>
                  <th>收件人</th>
                  <th>金額</th>
                  <th>狀態</th>
                  <th>成立時間</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.orders.map((order) => (
                  <tr key={order.id} class={detail?.order.id === order.id ? 'current' : ''}>
                    <td>
                      <code>{order.id}</code>
                    </td>
                    <td>{order.recipientName}</td>
                    <td>NT${order.total}</td>
                    <td>
                      <span class={`status ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                    </td>
                    <td>{when(order.createdAt)}</td>
                    <td>
                      <button type="button" onClick={() => void open(order)}>
                        明細
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {detail && (
          <div class="card order-detail">
            <h2>
              <code>{detail.order.id}</code>
              <span class={`status ${detail.order.status}`}>{STATUS_LABELS[detail.order.status]}</span>
            </h2>

            <div class="moves">
              {(MOVES[detail.order.status] ?? []).map((move) => (
                <button
                  key={move.action}
                  type="button"
                  class={move.action === 'cancel' ? 'danger' : ''}
                  disabled={busy}
                  onClick={() => act(detail.order, move)}
                >
                  {move.label}
                </button>
              ))}
              {!MOVES[detail.order.status] && <p class="muted">這筆訂單已經結束，沒有可以做的動作。</p>}
            </div>

            <h3>品項</h3>
            <table class="order-table">
              <tbody>
                {detail.items.map((item, index) => (
                  <tr key={index}>
                    <td>
                      {item.productTitle}
                      <small> {item.variantTitle}</small>
                    </td>
                    <td>NT${item.unitPrice} × {item.quantity}</td>
                    <td>NT${item.subtotal}</td>
                  </tr>
                ))}
                <tr>
                  <td>運費（{detail.order.shippingMethod}）</td>
                  <td />
                  <td>NT${detail.order.shippingFee}</td>
                </tr>
                <tr class="total">
                  <td>總計</td>
                  <td />
                  <td>NT${detail.order.total}</td>
                </tr>
              </tbody>
            </table>

            <h3>收件</h3>
            <dl class="facts">
              <dt>收件人</dt>
              <dd>
                {detail.order.recipientName}．{detail.order.recipientPhone}
              </dd>
              <dt>Email</dt>
              <dd>{detail.order.recipientEmail}</dd>
              {detail.order.storeName ? (
                <>
                  <dt>取貨門市</dt>
                  <dd>
                    {detail.order.storeName}
                    {detail.order.storeAddr ? `（${detail.order.storeAddr}）` : ''}
                  </dd>
                </>
              ) : (
                <>
                  <dt>地址</dt>
                  <dd>{detail.order.shippingAddress || '—'}</dd>
                </>
              )}
            </dl>

            <form class="product-form" onSubmit={saveNote}>
              <label>
                店家備註
                <input
                  value={note}
                  onInput={(event) => setNote((event.target as HTMLInputElement).value)}
                  maxLength={500}
                  placeholder="只有你看得到，顧客的訂單頁不會出現"
                />
              </label>
              <button type="submit" disabled={busy}>
                儲存備註
              </button>
            </form>

            {detail.attempts.length > 0 && (
              <>
                <h3>付款嘗試</h3>
                <ul class="audit">
                  {detail.attempts.map((attempt) => (
                    <li key={attempt.merTradeNo}>
                      <code>{attempt.merTradeNo}</code> NT${attempt.amount}．{attempt.status}．
                      {when(attempt.createdAt)}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>稽核紀錄</h3>
            {/* Every move is here with a name on it. This is the record that
                has to be right the day a payment is disputed. */}
            <ul class="audit">
              {detail.audit.map((entry, index) => (
                <li key={index}>
                  {when(entry.createdAt)}．<strong>{entry.actor}</strong>．{entry.action}
                  {entry.fromStatus && entry.toStatus ? `（${entry.fromStatus} → ${entry.toStatus}）` : ''}
                  {entry.detail ? `．${entry.detail}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </AdminShell>
  )
}
