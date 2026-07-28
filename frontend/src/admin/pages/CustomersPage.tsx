import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { ApiError, api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { AdminCustomer, AdminCustomerDetail, Order, OrderStatus } from '../../shared/types'
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

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function CustomersPage() {
  const [customers, setCustomers] = useState<AdminCustomer[] | null>(null)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const load = useCallback(async () => {
    const query = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''
    try {
      const data = await api<{ customers: AdminCustomer[] }>(`/api/customers${query}`)
      setCustomers(data.customers)
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [search, showError])

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

  async function open(customer: AdminCustomer) {
    try {
      setDetail(await api<AdminCustomerDetail>(`/api/customers/${encodeURIComponent(customer.id)}`))
    } catch (error) {
      showError(error)
    }
  }

  function setBlocked(customer: AdminCustomer, blocked: boolean) {
    if (blocked && !confirm(`封鎖 ${customer.email}？他們仍然看得到自己已經下的訂單，只是不能再結帳。`)) return
    void run(async () => {
      setDetail(
        await apiJson<AdminCustomerDetail>(`/api/customers/${encodeURIComponent(customer.id)}/blocked`, 'POST', {
          blocked,
        }),
      )
      await load()
    }, blocked ? '已封鎖。' : '已解除封鎖。')
  }

  function erase(customer: AdminCustomer) {
    const warning =
      `清除 ${customer.email} 的個人資料？\n\n` +
      '姓名、email、電話與地址會被覆蓋，這個動作無法還原。\n' +
      '已經成立的訂單會保留（那是店家的交易紀錄），上面的收件資料不會被動到。'
    if (!confirm(warning)) return
    void run(async () => {
      setDetail(
        await apiJson<AdminCustomerDetail>(`/api/customers/${encodeURIComponent(customer.id)}/anonymise`, 'POST', {}),
      )
      await load()
    }, '個人資料已清除。')
  }

  return (
    <AdminShell current="/customers" message={message} onError={showError}>
      <section class="stack shop">
        <div class="card">
          <h2>會員</h2>
          <p class="muted">顧客第一次用 Google 登入結帳時自動建立，沒有註冊流程。</p>

          <div class="order-filters">
            <input
              type="search"
              placeholder="email、顯示名稱或收件人"
              value={search}
              onInput={(event) => setSearch((event.target as HTMLInputElement).value)}
            />
          </div>

          {customers === null ? (
            <p class="muted">載入中…</p>
          ) : customers.length === 0 ? (
            <p class="muted">還沒有會員。</p>
          ) : (
            <table class="order-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>稱呼</th>
                  <th>訂單</th>
                  <th>已付金額</th>
                  <th>加入</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id} class={detail?.customer.id === customer.id ? 'current' : ''}>
                    <td>
                      {customer.email}
                      {customer.blocked && <span class="status cancelled">已封鎖</span>}
                      {customer.anonymizedAt && <span class="status expired">已清除</span>}
                    </td>
                    <td>{customer.displayName || '—'}</td>
                    <td>{customer.orderCount}</td>
                    <td>NT${customer.paidTotal}</td>
                    <td>{when(customer.createdAt)}</td>
                    <td>
                      <button type="button" onClick={() => void open(customer)}>
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
          <div class="card">
            <h2>{detail.customer.email}</h2>

            <dl class="facts">
              <dt>顯示名稱</dt>
              <dd>{detail.customer.displayName || '—'}</dd>
              <dt>預設收件人</dt>
              <dd>
                {detail.customer.recipientName || '—'}
                {detail.customer.recipientPhone ? `．${detail.customer.recipientPhone}` : ''}
              </dd>
              <dt>預設地址</dt>
              <dd>{detail.customer.address || '—'}</dd>
              <dt>加入時間</dt>
              <dd>{when(detail.customer.createdAt)}</dd>
              {detail.customer.anonymizedAt ? (
                <>
                  <dt>清除時間</dt>
                  <dd>{when(detail.customer.anonymizedAt)}</dd>
                </>
              ) : null}
            </dl>

            <div class="moves">
              {detail.customer.blocked ? (
                <button type="button" disabled={busy} onClick={() => setBlocked(detail.customer, false)}>
                  解除封鎖
                </button>
              ) : (
                <button type="button" class="danger" disabled={busy} onClick={() => setBlocked(detail.customer, true)}>
                  封鎖結帳
                </button>
              )}
              {!detail.customer.anonymizedAt && (
                <button type="button" class="danger" disabled={busy} onClick={() => erase(detail.customer)}>
                  清除個人資料
                </button>
              )}
            </div>
            {/* Said here, because "delete the member" is what people expect
                this button to do, and it is not what it does. */}
            <p class="muted">
              封鎖只擋結帳，不會登出，也不會影響他們查看已成立的訂單。清除會覆蓋個人資料但保留訂單——那是店家的交易紀錄。
            </p>

            <h3>訂單</h3>
            {detail.orders.length === 0 ? (
              <p class="muted">還沒有下過單。</p>
            ) : (
              <table class="order-table">
                <tbody>
                  {detail.orders.map((order: Order) => (
                    <tr key={order.id}>
                      <td>
                        <a href={`/orders?q=${encodeURIComponent(order.id)}`}>
                          <code>{order.id}</code>
                        </a>
                      </td>
                      <td>NT${order.total}</td>
                      <td>
                        <span class={`status ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                      </td>
                      <td>{when(order.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </AdminShell>
  )
}
