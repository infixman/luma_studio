import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  BulkBar,
  Button,
  ColumnChooser,
  DataTable,
  EmptyState,
  FilterBar,
  MenuItem,
  DEFAULT_PER_PAGE,
  Pagination,
  Panel,
  Spinner,
  TextField,
  Toolbar,
  activeCount,
  applyFilters,
  readHidden,
  useConfirm,
  writeHidden,
} from '../components/ui'
import type { Column, FilterField, FilterRule } from '../components/ui'
import { navigate } from '../lib/navigation'
import { api, apiJson } from '../../shared/api'
import type { AdminCustomer, PageInfo } from '../../shared/types'
import '../styles/orders-admin.css'
import '../styles/customers-admin.css'
import { dateOnly } from '../../shared/dates'
import { useLatest } from '../lib/latest'

const COLUMN_PAGE = 'customers'

const FIELDS: FilterField[] = [
  {
    name: 'blocked',
    label: '購物車',
    type: 'enum',
    options: [
      { value: 'no', label: '可使用' },
      { value: 'yes', label: '已停用' },
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

export function CustomersPage() {
  const [customers, setCustomers] = useState<AdminCustomer[] | null>(null)
  const [info, setInfo] = useState<PageInfo | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE)
  const [rules, setRules] = useState<FilterRule[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [hidden, setHidden] = useState<string[]>(() => readHidden(COLUMN_PAGE) ?? [])
  const [selected, setSelected] = useState<string[]>([])
  const { message, show, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()
  const latest = useLatest()

  // Search stays on the server: the browser only holds one page, so searching
  // here would only ever search the page it happens to be on.
  // Typing fast can put two searches in flight; only the current one paints.
  const load = useCallback(
    () =>
      latest(async (isCurrent) => {
        const query = new URLSearchParams({ page: String(page), perPage: String(perPage) })
        if (search.trim()) query.set('q', search.trim())
        try {
          const data = await api<{ customers: AdminCustomer[] } & PageInfo>(`/api/customers?${query}`)
          if (!isCurrent()) return
          setCustomers(data.customers)
          setInfo(data)
        } catch (error) {
          if (isCurrent()) showError(error)
        }
      }),
    [latest, page, perPage, search, showError],
  )

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
    narrow(() => setRules(next))
  }

  /**
   * Change what the list is showing, and go back to its first page.
   *
   * Narrowing while on page 7 lands on a page that no longer exists, which
   * looks exactly like "the search found nobody".
   */
  function narrow(change: () => void) {
    change()
    setPage(1)
    setSelected([])
  }

  function open(customer: AdminCustomer) {
    navigate(`/customers/${encodeURIComponent(customer.id)}`)
  }

  async function setBlocked(customer: AdminCustomer, blocked: boolean) {
    if (blocked) {
      const ok = await ask({
        title: '停用購物車',
        body: (
          <>
            <p>確定要停用 {customer.email} 的購物車嗎？</p>
            <p>他們仍然看得到自己已經下的訂單，也不會被登出，只是不能再結帳。</p>
          </>
        ),
        confirmLabel: '停用購物車',
      })
      if (!ok) return
    }
    void run(async () => {
      await apiJson(`/api/customers/${encodeURIComponent(customer.id)}/blocked`, 'POST', { blocked })
      await load()
    }, blocked ? '購物車已停用。' : '購物車已恢復。')
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
      show(blocked ? '選取會員的購物車都已停用。' : '選取會員的購物車都可以使用。', 'error')
      return
    }
    if (blocked) {
      const ok = await ask({
        title: `停用 ${targets.length} 位會員的購物車`,
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
        confirmLabel: '全部停用',
      })
      if (!ok) return
    }
    await run(async () => {
      for (const customer of targets) {
        await apiJson(`/api/customers/${encodeURIComponent(customer.id)}/blocked`, 'POST', { blocked })
      }
      setSelected([])
      await load()
    }, blocked ? `已停用 ${targets.length} 位會員的購物車。` : `已恢復 ${targets.length} 位會員的購物車。`)
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
      await apiJson(`/api/customers/${encodeURIComponent(customer.id)}/anonymise`, 'POST', {})
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
        <a class="admin-data-link customer-account-link" href={`/customers/${encodeURIComponent(customer.id)}`}>
          <span>{customer.email}</span>
          {customer.accountBlocked && <span class="customer-state is-danger">帳號停權</span>}
          {customer.cartBlocked && <span class="customer-state is-warning">購物車停用</span>}
          {customer.anonymizedAt && <span class="customer-state">已清除</span>}
        </a>
      ),
    },
    { key: 'displayName', label: '稱呼', render: (customer) => customer.displayName || '—' },
    {
      key: 'orderCount',
      label: '訂單',
      numeric: true,
      render: (customer) => (
        <a
          class="admin-data-link"
          href={`/orders?q=${encodeURIComponent(customer.email)}`}
          aria-label={`查看 ${customer.email} 的 ${customer.orderCount} 筆訂單`}
        >
          {customer.orderCount}
        </a>
      ),
    },
    { key: 'paidTotal', label: '已付金額', numeric: true, render: (customer) => `NT$${customer.paidTotal}` },
    { key: 'createdAt', label: '加入', render: (customer) => dateOnly(customer.createdAt) },
  ]

  return (
    <AdminShell current="/customers" message={message} onError={showError}>
      {dialog}

      {/* No title: the navigation and the title bar both already say 會員. */}
      <Panel>

        <Toolbar>
          <TextField
            label="搜尋"
            type="search"
            placeholder="email、顯示名稱或收件人"
            value={search}
            onInput={(event) => narrow(() => setSearch((event.currentTarget as HTMLInputElement).value))}
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



        <BulkBar count={selected.length} onClear={() => setSelected([])}>
          <Button size="sm" tone="danger" busy={busy} onClick={() => void blockSelected(true)}>
            停用購物車
          </Button>
          <Button size="sm" busy={busy} onClick={() => void blockSelected(false)}>
            恢復購物車
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
            menu={(customer) => (
              <>
                <MenuItem onClick={() => open(customer)}>查看會員</MenuItem>
                {customer.blocked ? (
                  <MenuItem onClick={() => void setBlocked(customer, false)}>恢復購物車</MenuItem>
                ) : (
                  <MenuItem tone="danger" onClick={() => void setBlocked(customer, true)}>
                    停用購物車
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
                        narrow(() => {
                          setRules([])
                          setSearch('')
                        })
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

        <Pagination
          info={info}
          unit="位"
          disabled={busy}
          onPage={(next) => {
            setPage(next)
            setSelected([])
          }}
          onPerPage={(size) => {
            setPerPage(size)
            setPage(1)
            setSelected([])
          }}
        />
      </Panel>

    </AdminShell>
  )
}
