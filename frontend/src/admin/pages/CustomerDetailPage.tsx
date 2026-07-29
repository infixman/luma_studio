import { useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  Spinner,
  TableWrap,
  TextArea,
  TextField,
  useConfirm,
} from '../components/ui'
import { api, apiJson } from '../../shared/api'
import { STOREFRONT_ORIGIN } from '../../shared/http/urls'
import type { AdminCustomerDetail, CustomerActivity, Order } from '../../shared/types'
import { dateOnly, dateTime } from '../../shared/dates'
import { ORDER_STATUS_LABELS } from '../../shared/presentation/order-status'
import { ORDER_STATUS_TONES } from '../features/orders/presentation'
import { ORDER_NOTE_MAX } from '../features/orders/constraints'
import '../styles/orders-admin.css'
import '../styles/customers-admin.css'

interface Draft {
  displayName: string
  recipientName: string
  recipientPhone: string
  address: string
  notes: string
}

function draftOf(detail: AdminCustomerDetail): Draft {
  return {
    displayName: detail.customer.displayName,
    recipientName: detail.customer.recipientName,
    recipientPhone: detail.customer.recipientPhone,
    address: detail.customer.address,
    notes: detail.customer.notes,
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return Object.keys(a).every((key) => a[key as keyof Draft] === b[key as keyof Draft])
}

const EVENT_LABELS: Record<CustomerActivity['type'], string> = {
  page_view: '瀏覽頁面',
  product_view: '查看商品',
  cart_add: '加入購物車',
}

function eventTarget(event: CustomerActivity) {
  if (event.productSlug) {
    return (
      <a
        class="admin-data-link customer-activity-target"
        href={`${STOREFRONT_ORIGIN}/shop/${encodeURIComponent(event.productSlug)}`}
        target="_blank"
        rel="noreferrer"
      >
        {event.productTitle || event.productSlug}
      </a>
    )
  }
  return event.path || '—'
}

export function CustomerDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const { message, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()
  const dirty = draft !== null && saved !== null && !sameDraft(draft, saved)

  async function load() {
    try {
      const next = await api<AdminCustomerDetail>(`/api/customers/${encodeURIComponent(id)}`)
      const nextDraft = draftOf(next)
      setDetail(next)
      setDraft(nextDraft)
      setSaved(nextDraft)
    } catch (error) {
      showError(error)
    }
  }

  useEffect(() => {
    void load()
  }, [id])

  async function save() {
    if (!detail || !draft) return
    await run(async () => {
      let next = await apiJson<AdminCustomerDetail>(
        `/api/customers/${encodeURIComponent(id)}/profile`,
        'POST',
        draft,
      )
      if (draft.notes !== detail.customer.notes) {
        next = await apiJson<AdminCustomerDetail>(
          `/api/customers/${encodeURIComponent(id)}/notes`,
          'POST',
          { notes: draft.notes },
        )
      }
      const nextDraft = draftOf(next)
      setDetail(next)
      setDraft(nextDraft)
      setSaved(nextDraft)
    }, '會員資料已儲存。')
  }

  async function setAccess(kind: 'account' | 'cart', blocked: boolean) {
    if (!detail) return
    const noun = kind === 'account' ? '帳號' : '購物車'
    if (blocked) {
      const ok = await ask({
        title: `停用${noun}`,
        body:
          kind === 'account' ? (
            <p>會員會立即登出，恢復前無法再次登入；訂單與資料仍會保留。</p>
          ) : (
            <p>會員仍可登入及查看訂單，但無法使用購物車或送出結帳。</p>
          ),
        confirmLabel: `停用${noun}`,
      })
      if (!ok) return
    }
    await run(async () => {
      const next = await apiJson<AdminCustomerDetail>(
        `/api/customers/${encodeURIComponent(id)}/${kind === 'account' ? 'account-blocked' : 'blocked'}`,
        'POST',
        { blocked },
      )
      setDetail(next)
    }, blocked ? `${noun}已停用。` : `${noun}已恢復。`)
  }

  async function anonymise() {
    if (!detail) return
    const ok = await ask({
      title: '清除個人資料',
      body: <p>姓名、email、電話與地址會被覆蓋，無法還原；交易訂單會保留。</p>,
      confirmLabel: '清除資料',
    })
    if (!ok) return
    await run(async () => {
      const next = await apiJson<AdminCustomerDetail>(
        `/api/customers/${encodeURIComponent(id)}/anonymise`,
        'POST',
        {},
      )
      const nextDraft = draftOf(next)
      setDetail(next)
      setDraft(nextDraft)
      setSaved(nextDraft)
    }, '個人資料已清除。')
  }

  return (
    <AdminShell
      current="/customers"
      title={detail?.customer.email ?? '會員'}
      back={{ href: '/customers', label: '回到會員清單' }}
      actions={
        <Button tone="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
          儲存
        </Button>
      }
      message={message}
      onError={showError}
    >
      {dialog}
      {!detail || !draft ? (
        <Spinner />
      ) : (
        <div class="customer-detail-layout">
          <div class="customer-detail-main">
            <Panel title="會員資料">
              <div class="customer-profile-grid">
                <TextField label="會員帳號" value={detail.customer.email} disabled hint="由 Google 帳號提供，不能在後台改寫。" />
                <TextField
                  label="顯示名稱"
                  value={draft.displayName}
                  maxLength={60}
                  disabled={Boolean(detail.customer.anonymizedAt)}
                  onInput={(event) => setDraft({ ...draft, displayName: event.currentTarget.value })}
                />
                <TextField
                  label="預設收件人"
                  value={draft.recipientName}
                  maxLength={25}
                  disabled={Boolean(detail.customer.anonymizedAt)}
                  onInput={(event) => setDraft({ ...draft, recipientName: event.currentTarget.value })}
                />
                <TextField
                  label="預設電話"
                  value={draft.recipientPhone}
                  maxLength={20}
                  disabled={Boolean(detail.customer.anonymizedAt)}
                  onInput={(event) => setDraft({ ...draft, recipientPhone: event.currentTarget.value })}
                />
                <TextField
                  label="預設地址"
                  value={draft.address}
                  maxLength={200}
                  disabled={Boolean(detail.customer.anonymizedAt)}
                  onInput={(event) => setDraft({ ...draft, address: event.currentTarget.value })}
                />
              </div>
              <TextArea
                label="店家備註"
                hint="只有後台看得到。"
                value={draft.notes}
                maxLength={ORDER_NOTE_MAX}
                onInput={(event) => setDraft({ ...draft, notes: event.currentTarget.value })}
              />
            </Panel>

            <Panel title="近期活動">
              <div class="customer-stats" aria-label={`近 ${detail.stats.periodDays} 天統計`}>
                <div><span>最後活動</span><strong>{detail.stats.lastSeenAt ? dateTime(detail.stats.lastSeenAt) : '尚無紀錄'}</strong></div>
                <div><span>瀏覽頁面</span><strong>{detail.stats.pageViews}</strong></div>
                <div><span>查看商品</span><strong>{detail.stats.productViews}</strong></div>
                <div><span>加入購物車</span><strong>{detail.stats.cartAdds}</strong></div>
              </div>
              <p class="muted">統計期間為最近 {detail.stats.periodDays} 天，只記錄會員登入後的操作。</p>
              {detail.activity.length === 0 ? (
                <EmptyState compact title="尚無活動紀錄" body="會員下次登入瀏覽、查看商品或加入購物車後會出現在這裡。" />
              ) : (
                <TableWrap>
                  <thead>
                    <tr><th>時間</th><th>動作</th><th>內容</th><th class="numeric">數量</th></tr>
                  </thead>
                  <tbody>
                    {detail.activity.map((event, index) => (
                      <tr key={`${event.createdAt}-${index}`}>
                        <td>{dateTime(event.createdAt)}</td>
                        <td>{EVENT_LABELS[event.type]}</td>
                        <td>{eventTarget(event)}</td>
                        <td class="numeric">{event.quantity ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </Panel>

            <Panel title="訂單">
              {detail.orders.length === 0 ? (
                <EmptyState compact title="還沒有下過單" body="這位會員登入過，但尚未成立訂單。" />
              ) : (
                <TableWrap>
                  <thead><tr><th>訂單</th><th>狀態</th><th class="numeric">金額</th><th>成立時間</th></tr></thead>
                  <tbody>
                    {detail.orders.map((order: Order) => (
                      <tr key={order.id}>
                        <td><a class="admin-data-link" href={`/orders?q=${encodeURIComponent(order.id)}`}><code>{order.id}</code></a></td>
                        <td><Badge tone={ORDER_STATUS_TONES[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge></td>
                        <td class="numeric">NT${order.total}</td>
                        <td>{dateOnly(order.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </Panel>
          </div>

          <aside class="customer-detail-side">
            <Panel title="存取設定">
              <div class="customer-access-setting">
                <div>
                  <strong>帳號</strong>
                  <p>{detail.customer.accountBlocked ? '已停權，無法登入。' : '可正常登入。'}</p>
                </div>
                {detail.customer.accountBlocked ? (
                  <Button onClick={() => void setAccess('account', false)}>恢復帳號</Button>
                ) : (
                  <Button tone="danger" onClick={() => void setAccess('account', true)}>停用帳號</Button>
                )}
              </div>
              <div class="customer-access-setting">
                <div>
                  <strong>購物車</strong>
                  <p>{detail.customer.cartBlocked ? '已停用，無法使用購物車或結帳。' : '可正常購物與結帳。'}</p>
                </div>
                {detail.customer.cartBlocked ? (
                  <Button onClick={() => void setAccess('cart', false)}>恢復購物車</Button>
                ) : (
                  <Button tone="danger" onClick={() => void setAccess('cart', true)}>停用購物車</Button>
                )}
              </div>
            </Panel>

            <Panel title="帳號摘要">
              <dl class="facts">
                <dt>加入日期</dt><dd>{dateOnly(detail.customer.createdAt)}</dd>
                <dt>訂單數</dt><dd>{detail.customer.orderCount}</dd>
                <dt>已付金額</dt><dd>NT${detail.customer.paidTotal}</dd>
                {detail.customer.anonymizedAt && <><dt>資料清除</dt><dd>{dateOnly(detail.customer.anonymizedAt)}</dd></>}
              </dl>
            </Panel>

            {!detail.customer.anonymizedAt && (
              <Panel title="個人資料">
                <p class="muted">清除後無法還原；既有交易訂單仍會保留。</p>
                <Button tone="danger" onClick={() => void anonymise()}>清除個人資料</Button>
              </Panel>
            )}
          </aside>
        </div>
      )}
    </AdminShell>
  )
}
