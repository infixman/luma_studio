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
  Menu,
  MenuGroup,
  MenuItem,
  Modal,
  Panel,
  Spinner,
  TableWrap,
  TextField,
  Toolbar,
  activeCount,
  dayEnd,
  dayStart,
  readHidden,
  useConfirm,
  writeHidden,
} from '../components/ui'
import type { BadgeTone, Column, FilterField, FilterRule } from '../components/ui'
import { api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { AdminOrder, AdminOrderDetail, AdminOrderList, OrderStatus } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/orders-admin.css'
import { dateTime } from '../../shared/dates'

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '等待付款',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已逾期',
}

/** The one place a status becomes a colour, shared with the member page. */
const STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  pending: 'warning',
  paid: 'info',
  shipped: 'primary',
  completed: 'success',
  cancelled: 'danger',
  expired: 'neutral',
}

const STATUSES = Object.keys(STATUS_LABELS) as OrderStatus[]

/**
 * What the shop can do to an order from where it is now.
 *
 * The same table the API enforces. Drawing a button the server would refuse
 * teaches people that the buttons lie.
 */
interface Move {
  action: string
  label: string
  /** What the dialog asks for before the move is made. */
  prompt?: string
  danger?: boolean
}

const MOVES: Partial<Record<OrderStatus, Move[]>> = {
  pending: [
    { action: 'paid', label: '標記已付款', prompt: '對到哪一筆匯款？（會記進稽核紀錄）' },
    { action: 'cancel', label: '取消訂單', prompt: '取消原因', danger: true },
  ],
  paid: [
    { action: 'shipped', label: '標記已出貨', prompt: '物流單號或交寄方式（可留空）' },
    { action: 'cancel', label: '取消訂單', prompt: '取消原因', danger: true },
  ],
  shipped: [
    { action: 'completed', label: '標記已完成' },
    { action: 'cancel', label: '退貨並取消', prompt: '退貨原因', danger: true },
  ],
}

const MAIL_STATUS: Record<string, string> = {
  pending: '等待寄出',
  sent: '已寄出',
  failed: '寄送失敗',
}

/** The one status a bulk action is offered for — and it already exists per row. */
const CANCELLABLE: OrderStatus[] = ['pending', 'paid', 'shipped']

const COLUMN_PAGE = 'orders'

/** Marks the rule a status tab owns, so the next click can clear its own. */
const TAB_RULE = 'tab-'

/**
 * Nine columns is more than fits comfortably, so four start switched off.
 * They are the ones you go looking for rather than scan — a phone number is
 * read when something has gone wrong, not on the way past.
 */
const DEFAULT_HIDDEN = ['recipientPhone', 'recipientEmail', 'shippingMethod', 'adminNote']

/**
 * The filter rules, as the query string the admin API takes.
 *
 * **Orders filter on the server.** The list stops at its limit, so narrowing
 * it here would narrow only the rows that made it back — and a list that has
 * silently filtered one page of an unknown many looks exactly like a complete
 * answer. Products and customers are small enough to do it in the browser;
 * this one is not, and the difference is the whole reason for this function.
 *
 * Dates are sent as seconds, worked out from the reader's own timezone. A
 * bare `2026-07-01` on the wire would have to be resolved by a server that
 * has no idea which midnight was meant, and would drop an order placed in the
 * evening out of a range that visibly includes its date.
 */
function ordersQuery(rules: FilterRule[], search: string): string {
  const query = new URLSearchParams()
  if (search.trim()) query.set('q', search.trim())

  for (const rule of rules) {
    if (!rule.value.trim()) continue
    if (rule.field === 'status') {
      // Only one "是" can hold at a time, so the last one wins rather than
      // being AND-ed into a list that can only ever be empty.
      if (rule.operator === 'eq') query.set('status', rule.value)
      else query.append('statusNot', rule.value)
      continue
    }
    if (rule.field === 'createdAt') {
      const bound = rule.operator === 'lte' ? dayEnd(rule.value) : dayStart(rule.value)
      if (bound === null) continue
      // Stacked date rules tighten rather than replace: the later "之後" and
      // the earlier "之前" are the ones that survive an AND.
      const key = rule.operator === 'lte' ? 'createdTo' : 'createdFrom'
      const existing = query.get(key)
      const kept =
        existing === null ? bound : rule.operator === 'lte' ? Math.min(Number(existing), bound) : Math.max(Number(existing), bound)
      query.set(key, String(kept))
    }
  }
  return query.toString()
}

/** Which status the tabs should light up: exactly one plain "狀態 是 X" rule. */
function tabStatus(rules: FilterRule[]): OrderStatus | '' {
  const chosen = rules.filter((rule) => rule.field === 'status' && rule.operator === 'eq' && rule.value)
  return chosen.length === 1 ? ((chosen[0]?.value ?? '') as OrderStatus) : ''
}

export function OrdersAdminPage() {
  const [list, setList] = useState<AdminOrderList | null>(null)
  const [rules, setRules] = useState<FilterRule[]>([])
  const [showFilters, setShowFilters] = useState(false)
  // Seeded from the URL, because the member page links here with the order
  // id in it. A link that lands on an unfiltered list is a link that lies.
  const [search, setSearch] = useState(new URLSearchParams(location.search).get('q') ?? '')
  const [hidden, setHidden] = useState<string[]>(() => readHidden(COLUMN_PAGE) ?? DEFAULT_HIDDEN)
  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  /** The order and the move waiting on the dialog that collects its reason. */
  const [pending, setPending] = useState<{ order: AdminOrder; move: Move } | null>(null)
  const [answer, setAnswer] = useState('')
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()

  const query = ordersQuery(rules, search)

  const load = useCallback(async () => {
    try {
      setList(await api<AdminOrderList>(`/api/orders${query ? `?${query}` : ''}`))
      clearLoginAttempt()
    } catch (error) {
      showError(error)
    }
  }, [query, showError])

  useEffect(() => {
    void load()
  }, [load])

  function chooseColumns(next: string[]) {
    setHidden(next)
    writeHidden(COLUMN_PAGE, next)
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

  async function open(order: AdminOrder) {
    try {
      const next = await api<AdminOrderDetail>(`/api/orders/${encodeURIComponent(order.id)}`)
      setDetail(next)
      setNote(next.order.adminNote)
    } catch (error) {
      showError(error)
    }
  }

  /** A move with nothing to ask goes straight through; the rest open a dialog. */
  function start(order: AdminOrder, move: Move) {
    if (!move.prompt && move.action !== 'cancel') {
      void commit(order, move, '')
      return
    }
    setAnswer('')
    setPending({ order, move })
  }

  async function commit(order: AdminOrder, move: Move, value: string) {
    setPending(null)
    const payload = move.action === 'cancel' ? { reason: value } : { detail: value }
    await run(async () => {
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

  /**
   * Bulk cancel. The only bulk action offered, because it is the only one
   * every selected order can be in a position to accept — "標記已出貨" over a
   * mixed selection would half work and report nothing about the other half.
   */
  async function cancelSelected() {
    const targets = orders.filter((order) => selected.includes(order.id) && CANCELLABLE.includes(order.status))
    const skipped = selected.length - targets.length
    if (targets.length === 0) {
      show('選取的訂單都已經結束了，沒有可以取消的。', 'error')
      return
    }
    const ok = await ask({
      title: `取消 ${targets.length} 筆訂單`,
      body: (
        <>
          <p>以下訂單會被取消，庫存全部退回：</p>
          <ul class="ui-name-list">
            {targets.map((order) => (
              <li key={order.id}>
                <code>{order.id}</code>．{order.recipientName}．NT${order.total}
              </li>
            ))}
          </ul>
          {skipped > 0 && <p>另外 {skipped} 筆已經結束，不會被動到。</p>}
        </>
      ),
      confirmLabel: '全部取消',
    })
    if (!ok) return
    await run(async () => {
      // One at a time and in order, because each one puts stock back and the
      // audit log should read in the order the shop actually did them.
      for (const order of targets) {
        await apiJson(`/api/orders/${encodeURIComponent(order.id)}/cancel`, 'POST', { reason: '批次取消' })
      }
      setSelected([])
      setDetail(null)
      await load()
    }, `已取消 ${targets.length} 筆訂單。`)
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
  const orders = useMemo(() => list?.orders ?? [], [list])
  const current = tabStatus(rules)
  const filtered = activeCount(rules) > 0 || search.trim() !== ''

  /** Counts ride along in the option labels, so the tabs are not the only place they live. */
  const fields: FilterField[] = [
    {
      name: 'status',
      label: '狀態',
      type: 'enum',
      options: STATUSES.map((status) => ({
        value: status,
        label: counts[status] ? `${STATUS_LABELS[status]}（${counts[status]}）` : STATUS_LABELS[status],
      })),
    },
    { name: 'createdAt', label: '成立時間', type: 'date' },
  ]

  const columns: Column<AdminOrder>[] = [
    {
      key: 'id',
      label: '訂單',
      // Not offered in the chooser: a row with no id is a row nobody can act
      // on, and every other column here is about that id.
      fixed: true,
      render: (order) => <code>{order.id}</code>,
    },
    { key: 'recipientName', label: '收件人', render: (order) => order.recipientName },
    { key: 'total', label: '金額', numeric: true, render: (order) => `NT$${order.total}` },
    {
      key: 'status',
      label: '狀態',
      render: (order) => <Badge tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Badge>,
    },
    { key: 'createdAt', label: '成立時間', render: (order) => dateTime(order.createdAt) },
    { key: 'recipientPhone', label: '電話', render: (order) => order.recipientPhone || '—' },
    { key: 'recipientEmail', label: 'Email', render: (order) => order.recipientEmail || '—' },
    { key: 'shippingMethod', label: '配送', render: (order) => order.shippingMethod },
    { key: 'adminNote', label: '備註', render: (order) => order.adminNote || '—' },
  ]

  /**
   * A changed filter drops the selection. The rows behind a bulk button are
   * not the rows that were ticked before it, and a selection that survived
   * would act on orders no longer on screen.
   */
  function changeRules(next: FilterRule[]) {
    setRules(next)
    setSelected([])
  }

  /** Puts the tabs and the filter rows on one model, so they cannot disagree. */
  /**
   * A tab click is a filter rule, which is what keeps the tabs and the list
   * from ever disagreeing.
   *
   * Every rule this function put there is cleared first, not only the ones
   * still shaped like `狀態 是 X`. Changing a tab rule's operator by hand left
   * it behind, and clicking the same tab again appended a second rule with the
   * same id — after which editing one row rewrote both, deleting one deleted
   * both, and the query asked for status=paid AND statusNot=paid, which can
   * never match anything.
   */
  function chooseTab(status: OrderStatus | '') {
    const others = rules.filter((rule) => !rule.id.startsWith(TAB_RULE))
    setRules(status ? [...others, { id: `${TAB_RULE}${status}`, field: 'status', operator: 'eq', value: status }] : others)
    setSelected([])
  }

  return (
    <AdminShell current="/orders" message={message} onError={showError}>
      {dialog}

      {/* Replaces both the browser's prompt() and its confirm(): one can only
          carry a string, the other can only ask yes or no, and this move
          needs to do both in the same breath. */}
      <Modal
        title={pending ? `${pending.move.label}：${pending.order.id}` : ''}
        open={pending !== null}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              tone={pending?.move.danger ? 'danger' : 'primary'}
              onClick={() => pending && void commit(pending.order, pending.move, answer)}
            >
              {pending?.move.label ?? '確定'}
            </Button>
          </>
        }
      >
        {pending?.move.action === 'cancel' && (
          <p>
            {pending.order.recipientName} 的這筆訂單會被取消，其中的庫存會全部退回。這個動作無法還原。
          </p>
        )}
        <TextField
          label={pending?.move.prompt ?? '說明'}
          hint="會記進稽核紀錄，顧客看不到。"
          value={answer}
          maxLength={500}
          onInput={(event) => setAnswer((event.currentTarget as HTMLInputElement).value)}
        />
      </Modal>

      <Panel title="訂單">
        <nav class="order-tabs" aria-label="依狀態篩選">
          <button type="button" class={current === '' ? 'current' : ''} onClick={() => chooseTab('')}>
            全部
          </button>
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              class={status === current ? 'current' : ''}
              onClick={() => chooseTab(status)}
            >
              {STATUS_LABELS[status]}
              {counts[status] ? <span class="count">{counts[status]}</span> : null}
            </button>
          ))}
        </nav>

        <Toolbar>
          <TextField
            label="搜尋"
            type="search"
            placeholder="訂單編號、收件人或 email"
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

        {showFilters && <FilterBar fields={fields} rules={rules} onChange={changeRules} />}

        {/* A list that stops at its limit without saying so reads as "the
            old orders are gone". */}
        {list?.truncated && (
          <p class="muted warn">只顯示最新的 {orders.length} 筆。用搜尋或篩選縮小範圍。</p>
        )}

        <BulkBar count={selected.length} onClear={() => setSelected([])}>
          <Button size="sm" tone="danger" busy={busy} onClick={() => void cancelSelected()}>
            取消訂單
          </Button>
        </BulkBar>

        {list === null ? (
          <Spinner />
        ) : (
          <DataTable
            rows={orders}
            columns={columns}
            hidden={hidden}
            rowKey={(order) => order.id}
            selected={selected}
            onSelectedChange={setSelected}
            rowClass={(order) => (detail?.order.id === order.id ? 'current' : '')}
            menu={(order) => (
              <>
                <MenuItem onClick={() => void open(order)}>看明細</MenuItem>
                {(MOVES[order.status] ?? []).length > 0 && <MenuGroup label="狀態" />}
                {(MOVES[order.status] ?? []).map((move) => (
                  <MenuItem
                    key={move.action}
                    tone={move.danger ? 'danger' : 'neutral'}
                    disabled={busy}
                    onClick={() => start(order, move)}
                  >
                    {move.label}
                  </MenuItem>
                ))}
              </>
            )}
            empty={
              filtered ? (
                <EmptyState
                  title="沒有符合的訂單"
                  body="條件把所有訂單都排除了。放寬一條，或清掉全部從頭看。"
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
                <EmptyState title="還沒有訂單" body="第一位顧客結帳之後，這裡就會有東西。" />
              )
            }
          />
        )}
      </Panel>

      {detail && (
        <Panel
          title={detail.order.id}
          actions={
            <>
              <Badge tone={STATUS_TONES[detail.order.status]}>{STATUS_LABELS[detail.order.status]}</Badge>
              {(MOVES[detail.order.status] ?? []).length > 0 ? (
                <Menu label="這筆訂單的動作" variant="button" trigger="動作">
                  {(MOVES[detail.order.status] ?? []).map((move) => (
                    <MenuItem
                      key={move.action}
                      tone={move.danger ? 'danger' : 'neutral'}
                      disabled={busy}
                      onClick={() => start(detail.order, move)}
                    >
                      {move.label}
                    </MenuItem>
                  ))}
                </Menu>
              ) : (
                <span class="muted">已經結束</span>
              )}
              <Button size="sm" tone="ghost" onClick={() => setDetail(null)}>
                關閉
              </Button>
            </>
          }
        >
          <h3>品項</h3>
          <TableWrap>
            <tbody>
              {detail.items.map((item, index) => (
                <tr key={index}>
                  <td>
                    {item.productTitle}
                    <small> {item.variantTitle}</small>
                  </td>
                  <td class="numeric">
                    NT${item.unitPrice} × {item.quantity}
                  </td>
                  <td class="numeric">NT${item.subtotal}</td>
                </tr>
              ))}
              <tr>
                <td>運費（{detail.order.shippingMethod}）</td>
                <td />
                <td class="numeric">NT${detail.order.shippingFee}</td>
              </tr>
              <tr class="total">
                <td>總計</td>
                <td />
                <td class="numeric">NT${detail.order.total}</td>
              </tr>
            </tbody>
          </TableWrap>

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

          <form class="ui-inline-form" onSubmit={saveNote}>
            <TextField
              label="店家備註"
              hint="只有你看得到，顧客的訂單頁不會出現。"
              value={note}
              maxLength={500}
              onInput={(event) => setNote((event.currentTarget as HTMLInputElement).value)}
            />
            <Button type="submit" tone="primary" busy={busy}>
              儲存備註
            </Button>
          </form>

          {detail.attempts.length > 0 && (
            <>
              <h3>付款嘗試</h3>
              <ul class="audit">
                {detail.attempts.map((attempt) => (
                  <li key={attempt.merTradeNo}>
                    <code>{attempt.merTradeNo}</code> NT${attempt.amount}．{attempt.status}．
                    {dateTime(attempt.createdAt)}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>通知信</h3>
          {/* Queued, not sent here: the cron delivers within five minutes.
              Shown so "did they get the shipping notice" has an answer that
              does not need a database console. */}
          {detail.emails.length === 0 ? (
            <p class="muted">還沒有寄給這位顧客的信。沒有設定寄信服務時不會排入。</p>
          ) : (
            <ul class="audit">
              {detail.emails.map((email, index) => (
                <li key={index}>
                  {MAIL_STATUS[email.status] ?? email.status}．{email.subject}．{email.recipient}
                  {email.sentAt ? `．${dateTime(email.sentAt)}` : ''}
                  {email.lastError ? `．${email.lastError}` : ''}
                </li>
              ))}
            </ul>
          )}

          <h3>稽核紀錄</h3>
          {/* Every move is here with a name on it. This is the record that
              has to be right the day a payment is disputed. */}
          <ul class="audit">
            {detail.audit.map((entry, index) => (
              <li key={index}>
                {dateTime(entry.createdAt)}．<strong>{entry.actor}</strong>．{entry.action}
                {entry.fromStatus && entry.toStatus ? `（${entry.fromStatus} → ${entry.toStatus}）` : ''}
                {entry.detail ? `．${entry.detail}` : ''}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </AdminShell>
  )
}
