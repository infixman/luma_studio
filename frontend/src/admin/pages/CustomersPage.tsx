import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Badge, Button, EmptyState, Panel, Spinner, TableWrap, TextField, useConfirm } from '../components/ui'
import type { BadgeTone } from '../components/ui'
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

/** The one place a status becomes a colour, so the two lists cannot disagree. */
export const STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  pending: 'warning',
  paid: 'info',
  shipped: 'primary',
  completed: 'success',
  cancelled: 'danger',
  expired: 'neutral',
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function CustomersPage() {
  const [customers, setCustomers] = useState<AdminCustomer[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    const query = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''
    try {
      const data = await api<{ customers: AdminCustomer[]; truncated: boolean }>(`/api/customers${query}`)
      setCustomers(data.customers)
      setTruncated(data.truncated)
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

  async function setBlocked(customer: AdminCustomer, blocked: boolean) {
    if (blocked) {
      const ok = await ask({
        title: '封鎖結帳',
        body: (
          <>
            <p>確定要封鎖 {customer.email} 嗎？</p>
            <p>他們仍然看得到自己已經下的訂單，也不會被登出，只是不能再結帳。</p>
          </>
        ),
        confirmLabel: '封鎖',
      })
      if (!ok) return
    }
    void run(async () => {
      setDetail(
        await apiJson<AdminCustomerDetail>(`/api/customers/${encodeURIComponent(customer.id)}/blocked`, 'POST', {
          blocked,
        }),
      )
      await load()
    }, blocked ? '已封鎖。' : '已解除封鎖。')
  }

  async function erase(customer: AdminCustomer) {
    const ok = await ask({
      title: '清除個人資料',
      body: (
        <>
          <p>確定要清除 {customer.email} 的個人資料嗎？</p>
          <p>姓名、email、電話與地址會被覆蓋，這個動作無法還原。</p>
          <p>已經成立的訂單會保留——那是店家的交易紀錄——上面的收件資料不會被動到。</p>
        </>
      ),
      confirmLabel: '清除資料',
    })
    if (!ok) return
    void run(async () => {
      setDetail(
        await apiJson<AdminCustomerDetail>(`/api/customers/${encodeURIComponent(customer.id)}/anonymise`, 'POST', {}),
      )
      await load()
    }, '個人資料已清除。')
  }

  return (
    <AdminShell current="/customers" message={message} onError={showError}>
      {dialog}

      <Panel title="會員">
        <p class="muted">顧客第一次用 Google 登入結帳時自動建立，沒有註冊流程。</p>

        <TextField
          label="搜尋"
          type="search"
          placeholder="email、顯示名稱或收件人"
          value={search}
          onInput={(event) => setSearch((event.currentTarget as HTMLInputElement).value)}
        />

        {truncated && <p class="muted warn">只顯示最新的 {customers?.length} 位。用搜尋縮小範圍。</p>}

        {customers === null ? (
          <Spinner />
        ) : customers.length === 0 ? (
          <EmptyState
            title={search.trim() ? '沒有符合的會員' : '還沒有會員'}
            body={search.trim() ? '換個關鍵字試試，或清空搜尋看全部。' : '第一位顧客用 Google 登入結帳時，這裡就會有人。'}
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th>Email</th>
                <th>稱呼</th>
                <th class="numeric">訂單</th>
                <th class="numeric">已付金額</th>
                <th>加入</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id} class={detail?.customer.id === customer.id ? 'current' : ''}>
                  <td>
                    {customer.email}
                    {customer.blocked && <Badge tone="danger">已封鎖</Badge>}
                    {customer.anonymizedAt && <Badge>已清除</Badge>}
                  </td>
                  <td>{customer.displayName || '—'}</td>
                  <td class="numeric">{customer.orderCount}</td>
                  <td class="numeric">NT${customer.paidTotal}</td>
                  <td>{when(customer.createdAt)}</td>
                  <td>
                    <Button size="sm" onClick={() => void open(customer)}>
                      明細
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      {detail && (
        <Panel
          title={detail.customer.email}
          actions={
            <>
              {detail.customer.blocked ? (
                <Button size="sm" busy={busy} onClick={() => void setBlocked(detail.customer, false)}>
                  解除封鎖
                </Button>
              ) : (
                <Button size="sm" tone="danger" busy={busy} onClick={() => void setBlocked(detail.customer, true)}>
                  封鎖結帳
                </Button>
              )}
              {!detail.customer.anonymizedAt && (
                <Button size="sm" tone="danger" busy={busy} onClick={() => void erase(detail.customer)}>
                  清除個人資料
                </Button>
              )}
            </>
          }
        >
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

          {/* Said here, because "delete the member" is what people expect
              those buttons to do, and it is not what they do. */}
          <p class="muted">
            封鎖只擋結帳，不會登出，也不會影響他們查看已成立的訂單。清除會覆蓋個人資料但保留訂單——那是店家的交易紀錄。
          </p>

          <h3>訂單</h3>
          {detail.orders.length === 0 ? (
            <p class="muted">還沒有下過單。</p>
          ) : (
            <TableWrap>
              <tbody>
                {detail.orders.map((order: Order) => (
                  <tr key={order.id}>
                    <td>
                      <a href={`/orders?q=${encodeURIComponent(order.id)}`}>
                        <code>{order.id}</code>
                      </a>
                    </td>
                    <td class="numeric">NT${order.total}</td>
                    <td>
                      <Badge tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Badge>
                    </td>
                    <td>{when(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>
      )}
    </AdminShell>
  )
}
