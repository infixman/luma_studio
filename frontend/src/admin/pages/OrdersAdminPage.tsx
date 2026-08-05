import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  BulkBar,
  Button,
  ColumnChooser,
  DEFAULT_PER_PAGE,
  DataTable,
  EmptyState,
  Menu,
  MenuGroup,
  MenuItem,
  Modal,
  Pagination,
  Panel,
  Spinner,
  TableWrap,
  TextField,
  dayEnd,
  dayStart,
  readHidden,
  useConfirm,
  writeHidden,
} from '../components/ui'
import type { Column } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import type { AdminOrder, AdminOrderDetail, AdminOrderList, OrderStatus } from '../../shared/types'
import { ORDER_STATUS_LABELS } from '../../shared/presentation/order-status'
import { ORDER_STATUS_TONES } from '../features/orders/presentation'
import { ORDER_NOTE_MAX } from '../features/orders/constraints'
import '../styles/orders-admin.css'
import { dateTime } from '../../shared/dates'
import { useLatest } from '../lib/latest'

const STATUSES = Object.keys(ORDER_STATUS_LABELS) as OrderStatus[]

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

/**
 * Ten columns is more than fits comfortably, so four start switched off.
 * They are the ones you go looking for rather than scan — a phone number is
 * read when something has gone wrong, not on the way past.
 */
const DEFAULT_HIDDEN = ['recipientPhone', 'recipientEmail', 'shippingMethod', 'adminNote']

function ordersQuery(
  statuses: OrderStatus[],
  dateFrom: string,
  dateTo: string,
  search: string,
  page: number,
  perPage: number,
): string {
  const query = new URLSearchParams()
  if (search.trim()) query.set('q', search.trim())
  query.set('page', String(page))
  query.set('perPage', String(perPage))
  for (const s of statuses) query.append('status', s)
  const from = dayStart(dateFrom)
  if (from !== null) query.set('createdFrom', String(from))
  const to = dayEnd(dateTo)
  if (to !== null) query.set('createdTo', String(to))
  return query.toString()
}

export function OrdersAdminPage() {
  const [list, setList] = useState<AdminOrderList | null>(null)
  const [selectedStatuses, setSelectedStatuses] = useState<OrderStatus[]>([])
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState(new URLSearchParams(location.search).get('q') ?? '')
  const [hidden, setHidden] = useState<string[]>(() => readHidden(COLUMN_PAGE) ?? DEFAULT_HIDDEN)
  const [selected, setSelected] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE)
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null)
  const [note, setNote] = useState('')
  const noteDirty = detail !== null && note !== detail.order.adminNote

  // An order response from before fulfilments existed has none; reading that
  // as an empty list keeps an older cached page from throwing.
  const fulfillments = detail?.fulfillments ?? []
  const digital = fulfillments.filter((entry) => entry.type === 'course')
  const physical = fulfillments.filter((entry) => entry.type === 'inventory')
  const availableMoves = shippableMoves(
    detail === null ? [] : MOVES[detail.order.status] ?? [],
    detail?.hasPhysical,
  )
  /** The order and the move waiting on the dialog that collects its reason. */
  const [pending, setPending] = useState<{ order: AdminOrder; move: Move } | null>(null)
  const [answer, setAnswer] = useState('')
  const { message, show, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()
  const latest = useLatest()

  const query = ordersQuery(selectedStatuses, dateFrom, dateTo, search, page, perPage)

  // Filtering and searching both re-run this, and a slow answer to an older
  // query must not land on top of a fast answer to the current one.
  const load = useCallback(
    () =>
      latest(async (isCurrent) => {
        try {
          const answer = await api<AdminOrderList>(`/api/orders${query ? `?${query}` : ''}`)
          if (isCurrent()) setList(answer)
        } catch (error) {
          if (isCurrent()) showError(error)
        }
      }),
    [latest, query, showError],
  )

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Change what the list is showing, and go back to its first page.
   *
   * Narrowing while on page 7 lands on a page that no longer exists, which
   * looks exactly like "the search found nothing".
   */
  function narrow(change: () => void) {
    change()
    setPage(1)
    setSelected([])
  }

  function chooseColumns(next: string[]) {
    setHidden(next)
    writeHidden(COLUMN_PAGE, next)
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

  /**
   * Re-run what payment should have done. Safe to press twice.
   *
   * The server runs the same provisioning the payment callback runs, rather
   * than granting the course by hand: a hand-made grant has no fulfilment to
   * name it by, so a later refund would not take it back.
   */
  async function reconcile() {
    if (!detail) return
    await run(async () => {
      const next = await apiJson<AdminOrderDetail>(
        `/api/orders/${encodeURIComponent(detail.order.id)}/reconcile-entitlements`,
        'POST',
        {},
      )
      setDetail(next)
      await load()
    }, '已重新開通。')
  }

  const counts = list?.counts ?? {}
  const orders = useMemo(() => list?.orders ?? [], [list])
  const filtered = selectedStatuses.length > 0 || dateFrom !== '' || dateTo !== '' || search.trim() !== ''

  const columns: Column<AdminOrder>[] = [
    {
      key: 'id',
      label: '訂單',
      // Not offered in the chooser: a row with no id is a row nobody can act
      // on, and every other column here is about that id.
      fixed: true,
      render: (order) => (
        <button type="button" class="order-link" onClick={() => open(order)}>
          <code>{order.id}</code>
        </button>
      ),
    },
    { key: 'customerEmail', label: '會員帳號', render: (order) => order.customerEmail || '—' },
    { key: 'recipientName', label: '收件人', render: (order) => order.recipientName },
    { key: 'total', label: '金額', numeric: true, render: (order) => `NT$${order.total}` },
    {
      key: 'status',
      label: '狀態',
      render: (order) => <Badge tone={ORDER_STATUS_TONES[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>,
    },
    { key: 'createdAt', label: '成立時間', render: (order) => dateTime(order.createdAt) },
    { key: 'recipientPhone', label: '電話', render: (order) => order.recipientPhone || '—' },
    { key: 'recipientEmail', label: '收件 Email', render: (order) => order.recipientEmail || '—' },
    { key: 'shippingMethod', label: '配送', render: (order) => order.shippingMethod },
    { key: 'adminNote', label: '備註', render: (order) => order.adminNote || '—' },
  ]

  function toggleStatus(status: OrderStatus) {
    narrow(() =>
      setSelectedStatuses((prev) =>
        prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
      ),
    )
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
          maxLength={ORDER_NOTE_MAX}
          onInput={(event) => setAnswer((event.currentTarget as HTMLInputElement).value)}
        />
      </Modal>

      <Panel class="orders-list-panel">
        <div class="order-filter-bar" aria-label="訂單篩選">
          <section class="order-status-filter" aria-labelledby="order-status-filter-label">
            <div class="order-filter-heading">
              <h2 class="ui-subhead" id="order-status-filter-label">狀態</h2>
              <span>可複選，符合任一狀態（OR）</span>
            </div>
            <div class="order-status-checks">
              {STATUSES.map((status) => (
                <label key={status} class={selectedStatuses.includes(status) ? 'checked' : ''}>
                  <input
                    type="checkbox"
                    checked={selectedStatuses.includes(status)}
                    onChange={() => toggleStatus(status)}
                  />
                  {ORDER_STATUS_LABELS[status]}
                  {counts[status] ? <span class="count">{counts[status]}</span> : null}
                </label>
              ))}
            </div>
          </section>

          <section class="order-date-filter" aria-labelledby="order-date-filter-label">
            <h2 class="ui-subhead" id="order-date-filter-label">訂單成立日期</h2>
            <div class="order-date-fields">
              <div class={dateFrom ? 'order-date-control' : 'order-date-control is-empty'}>
                <TextField
                  label="從"
                  type="date"
                  value={dateFrom}
                  onInput={(event) =>
                    narrow(() => setDateFrom((event.currentTarget as HTMLInputElement).value))
                  }
                />
              </div>
              <div class={dateTo ? 'order-date-control' : 'order-date-control is-empty'}>
                <TextField
                  label="到"
                  type="date"
                  value={dateTo}
                  onInput={(event) =>
                    narrow(() => setDateTo((event.currentTarget as HTMLInputElement).value))
                  }
                />
              </div>
            </div>
          </section>

          <div class="order-search">
            <TextField
              label="搜尋"
              type="search"
              placeholder="訂單編號、會員帳號、收件人或收件 Email"
              value={search}
              onInput={(event) => narrow(() => setSearch((event.currentTarget as HTMLInputElement).value))}
            />
          </div>

          <p class="order-filter-logic">狀態、成立日期與搜尋會同時套用（AND）。</p>
        </div>

        <div class="order-list-toolbar">
          <div class="order-list-settings">
            <ColumnChooser columns={columns} hidden={hidden} onChange={chooseColumns} />
          </div>
        </div>

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
                      onClick={() =>
                        narrow(() => {
                          setSelectedStatuses([])
                          setDateFrom('')
                          setDateTo('')
                          setSearch('')
                        })
                      }
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

        <Pagination
          info={list}
          unit="筆"
          disabled={busy}
          onPage={(next) => {
            setPage(next)
            // The rows are about to be different rows.
            setSelected([])
          }}
          onPerPage={(size) => {
            setPerPage(size)
            setPage(1)
            setSelected([])
          }}
        />
      </Panel>

      {detail && (
        <Panel
          title={detail.order.id}
          actions={
            <>
              <Badge tone={ORDER_STATUS_TONES[detail.order.status]}>{ORDER_STATUS_LABELS[detail.order.status]}</Badge>
              {availableMoves.length > 0 ? (
                <Menu label="這筆訂單的動作" variant="button" trigger="動作">
                  {availableMoves.map((move) => (
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
              <Button type="submit" form="order-note" size="sm" tone="primary" busy={busy} disabled={!noteDirty}>
                儲存備註
              </Button>
              <Button size="sm" tone="ghost" onClick={() => setDetail(null)}>
                關閉
              </Button>
            </>
          }
        >
          {digital.length > 0 && (
            <>
              <h3>數位內容</h3>
              <TableWrap>
                <tbody>
                  {digital.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.targetTitle}</td>
                      <td>
                        {entry.accessDays === null ? '永久觀看' : `觀看後 ${entry.accessDays} 天`}
                      </td>
                      <td class="numeric">
                        {/* Not "shipped": a grant is available the moment
                            payment lands, and nothing is in the post. */}
                        {entry.status === 'fulfilled' ? '已開通' : '待開通'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              {/* The one failure a customer feels immediately and cannot work
                  around: they paid, and the course is not there. */}
              {needsEntitlementRepair(detail.order, digital) && (
                <div class="order-reconcile">
                  <p class="muted">
                    這筆訂單付款已收到，但上面還有課程沒有開通。重新開通會重跑付款當下該做的事，
                    重複執行是安全的。
                  </p>
                  <Button size="sm" tone="primary" busy={busy} onClick={() => void reconcile()}>
                    重新開通
                  </Button>
                </div>
              )}
            </>
          )}

          {physical.length > 0 && (
            <>
              <h3>待出貨內容</h3>
              <TableWrap>
                <tbody>
                  {physical.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        {entry.targetTitle}
                        {entry.sku && <small> {entry.sku}</small>}
                      </td>
                      <td class="numeric">×{entry.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </>
          )}

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

          <h3>會員</h3>
          <dl class="facts">
            <dt>會員帳號</dt>
            <dd>{detail.order.customerEmail || '—'}</dd>
            <dt>會員稱呼</dt>
            <dd>{detail.order.customerDisplayName || '—'}</dd>
          </dl>

          <h3>收件</h3>
          <dl class="facts">
            <dt>收件人</dt>
            <dd>
              {detail.order.recipientName}．{detail.order.recipientPhone}
            </dd>
            <dt>收件 Email</dt>
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

          <form id="order-note" class="ui-inline-form" onSubmit={saveNote}>
            <TextField
              label="店家備註"
              hint="只有你看得到，顧客的訂單頁不會出現。"
              value={note}
              maxLength={ORDER_NOTE_MAX}
              onInput={(event) => setNote((event.currentTarget as HTMLInputElement).value)}
            />
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
            <EmptyState title="還沒有寄給這位顧客的信" body="沒有設定寄信服務時不會排入。" compact />
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

/**
 * The moves worth offering for an order.
 *
 * Nothing was ever going in a box, so offering "mark as shipped" would let
 * somebody tell a customer a parcel is on its way when none exists. The
 * server refuses it too; this is so the button is not there to press.
 *
 * When `hasPhysical` is undefined the action stays. That only happens if the
 * back office is newer than the API it is talking to — a rollback, given the
 * admin-first deploy order — and hiding the button there would leave real
 * parcels unshippable, whereas showing it costs at most the 409 the server
 * already returns.
 */
export function shippableMoves<T extends { action: string }>(
  moves: readonly T[],
  hasPhysical: boolean | undefined,
): T[] {
  return moves.filter((move) => move.action !== 'shipped' || hasPhysical !== false)
}

/**
 * Whether to offer the repair for a paid order whose course never landed.
 *
 * Both halves matter. Money must have arrived, or the button hands out a
 * course nobody bought. And something must actually be missing — a repair
 * offered on a healthy order invites a click that means nothing, and teaches
 * people to press it whenever they are unsure.
 *
 * Not `status === 'paid'`: a mixed order whose parcel went out is `shipped`,
 * and its course can still be the part that failed.
 */
export function needsEntitlementRepair(
  order: { paidAt: number | null; status: string },
  digital: readonly { status: string }[],
): boolean {
  if (order.paidAt === null || order.status === 'cancelled' || order.status === 'expired') return false
  return digital.some((entry) => entry.status !== 'fulfilled')
}
