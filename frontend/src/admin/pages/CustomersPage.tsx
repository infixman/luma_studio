import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  BulkBar,
  Button,
  ColumnChooser,
  DataTable,
  EmptyState,
  FilterBar,
  MenuItem,
  Panel,
  Spinner,
  TableWrap,
  TextField,
  Toolbar,
  activeCount,
  applyFilters,
  readHidden,
  useConfirm,
  writeHidden,
} from '../components/ui'
import type { BadgeTone, Column, FilterField, FilterRule } from '../components/ui'
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

const COLUMN_PAGE = 'customers'

const FIELDS: FilterField[] = [
  {
    name: 'blocked',
    label: '結帳權限',
    type: 'enum',
    options: [
      { value: 'no', label: '正常' },
      { value: 'yes', label: '已封鎖' },
    ],
  },
  {
    name: 'anonymised',
    label: '個人資料',
    type: 'enum',
    options: [
      { value: 'no', label: '保留中' },
      { value: 'yes', label: '已清除' },
    ],
  },
  { name: 'orderCount', label: '訂單數', type: 'number' },
  { name: 'paidTotal', label: '已付金額', type: 'number' },
  { name: 'createdAt', label: '加入時間', type: 'date' },
]

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function CustomersPage() {
  const [customers, setCustomers] = useState<AdminCustomer[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [search, setSearch] = useState('')
  const [rules, setRules] = useState<FilterRule[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [hidden, setHidden] = useState<string[]>(() => readHidden(COLUMN_PAGE) ?? [])
  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  // Search stays on the server: it is the thing that reaches past the cap, so
  // doing it here would only search the hundred rows the cap let through.
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

  function chooseColumns(next: string[]) {
    setHidden(next)
    writeHidden(COLUMN_PAGE, next)
  }

  /**
   * A changed filter drops the selection: the rows behind a bulk button are
   * not the rows that were ticked before it.
   */
  function changeRules(next: FilterRule[]) {
    setRules(next)
    setSelected([])
  }

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

  /**
   * Blocking in bulk — the same switch the row menu already has. Clearing
   * personal data is deliberately not offered here: it exists as a single
   * action and cannot be undone, and a checkbox list is the wrong place to
   * reach for something that irreversible.
   */
  async function blockSelected(blocked: boolean) {
    const targets = shown.filter((customer) => selected.includes(customer.id) && customer.blocked !== blocked)
    if (targets.length === 0) {
      show(blocked ? '選取的會員都已經是封鎖狀態。' : '選取的會員都沒有被封鎖。', 'error')
      return
    }
    if (blocked) {
      const ok = await ask({
        title: `封鎖 ${targets.length} 位會員`,
        body: (
          <>
            <p>以下會員將無法再結帳。他們不會被登出，也仍然看得到自己已經下的訂單。</p>
            <ul class="ui-name-list">
              {targets.map((customer) => (
                <li key={customer.id}>{customer.email}</li>
              ))}
            </ul>
          </>
        ),
        confirmLabel: '全部封鎖',
      })
      if (!ok) return
    }
    await run(async () => {
      for (const customer of targets) {
        await apiJson(`/api/customers/${encodeURIComponent(customer.id)}/blocked`, 'POST', { blocked })
      }
      setSelected([])
      await load()
    }, blocked ? `已封鎖 ${targets.length} 位。` : `已解除 ${targets.length} 位的封鎖。`)
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

  /**
   * **Members filter in the browser.** Unlike the orders list, every rule here
   * is about something already on the row — blocked, anonymised, how many
   * orders — so there is nothing to ask the server that it has not already
   * said. Search is the exception and stays on the server, because it is what
   * reaches past the cap rather than inside it.
   */
  const shown = useMemo(
    () =>
      applyFilters(customers ?? [], rules, FIELDS, (customer, field) => {
        switch (field) {
          case 'blocked':
            return customer.blocked ? 'yes' : 'no'
          case 'anonymised':
            return customer.anonymizedAt ? 'yes' : 'no'
          case 'orderCount':
            return customer.orderCount
          case 'paidTotal':
            return customer.paidTotal
          default:
            return customer.createdAt
        }
      }),
    [customers, rules],
  )

  const filtered = activeCount(rules) > 0 || search.trim() !== ''

  const columns: Column<AdminCustomer>[] = [
    {
      key: 'email',
      label: 'Email',
      // The only thing that names the person. Everything else on the row is
      // about them, so it cannot be the column that disappears.
      fixed: true,
      render: (customer) => (
        <span class="customer-cell">
          {customer.email}
          {customer.blocked && <Badge tone="danger">已封鎖</Badge>}
          {customer.anonymizedAt && <Badge>已清除</Badge>}
        </span>
      ),
    },
    { key: 'displayName', label: '稱呼', render: (customer) => customer.displayName || '—' },
    { key: 'orderCount', label: '訂單', numeric: true, render: (customer) => customer.orderCount },
    { key: 'paidTotal', label: '已付金額', numeric: true, render: (customer) => `NT$${customer.paidTotal}` },
    { key: 'createdAt', label: '加入', render: (customer) => when(customer.createdAt) },
  ]

  return (
    <AdminShell current="/customers" message={message} onError={showError}>
      {dialog}

      <Panel title="會員">
        <p class="muted">顧客第一次用 Google 登入結帳時自動建立，沒有註冊流程。</p>

        <Toolbar>
          <TextField
            label="搜尋"
            type="search"
            placeholder="email、顯示名稱或收件人"
            value={search}
            onInput={(event) => setSearch((event.currentTarget as HTMLInputElement).value)}
          />
          <div class="ui-toolbar-end">
            <Button size="sm" onClick={() => setShowFilters((open) => !open)}>
              篩選{activeCount(rules) > 0 ? ` (${activeCount(rules)})` : ''}
            </Button>
            <ColumnChooser columns={columns} hidden={hidden} onChange={chooseColumns} />
          </div>
        </Toolbar>

        {showFilters && (
          <FilterBar fields={FIELDS} rules={rules} onChange={changeRules} />
        )}

        {truncated && <p class="muted warn">只顯示最新的 {customers?.length} 位。用搜尋縮小範圍。</p>}

        <BulkBar count={selected.length} onClear={() => setSelected([])}>
          <Button size="sm" tone="danger" busy={busy} onClick={() => void blockSelected(true)}>
            封鎖結帳
          </Button>
          <Button size="sm" busy={busy} onClick={() => void blockSelected(false)}>
            解除封鎖
          </Button>
        </BulkBar>

        {customers === null ? (
          <Spinner />
        ) : (
          <DataTable
            rows={shown}
            columns={columns}
            hidden={hidden}
            rowKey={(customer) => customer.id}
            selected={selected}
            onSelectedChange={setSelected}
            rowClass={(customer) => (detail?.customer.id === customer.id ? 'current' : '')}
            menu={(customer) => (
              <>
                <MenuItem onClick={() => void open(customer)}>看明細</MenuItem>
                {customer.blocked ? (
                  <MenuItem onClick={() => void setBlocked(customer, false)}>解除封鎖</MenuItem>
                ) : (
                  <MenuItem tone="danger" onClick={() => void setBlocked(customer, true)}>
                    封鎖結帳
                  </MenuItem>
                )}
                {!customer.anonymizedAt && (
                  <MenuItem tone="danger" onClick={() => void erase(customer)}>
                    清除個人資料
                  </MenuItem>
                )}
              </>
            )}
            empty={
              filtered ? (
                <EmptyState
                  title="沒有符合的會員"
                  body="條件把所有會員都排除了。放寬一條，或清掉全部從頭看。"
                  action={
                    <Button
                      onClick={() => {
                        setRules([])
                        setSearch('')
                      }}
                    >
                      清除搜尋與篩選
                    </Button>
                  }
                />
              ) : (
                <EmptyState title="還沒有會員" body="第一位顧客用 Google 登入結帳時，這裡就會有人。" />
              )
            }
          />
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
              <Button size="sm" tone="ghost" onClick={() => setDetail(null)}>
                關閉
              </Button>
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
            <EmptyState title="還沒有下過單" body="這位會員登入過，但還沒有完成任何一筆結帳。" />
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
