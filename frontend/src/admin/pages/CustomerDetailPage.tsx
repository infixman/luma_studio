import { useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  Panel,
  RadioGroup,
  Select,
  Spinner,
  TableWrap,
  TextArea,
  TextField,
  useConfirm,
} from '../components/ui'
import type { BadgeTone } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import { STOREFRONT_ORIGIN } from '../../shared/http/urls'
import type {
  AdminCustomerDetail,
  Course,
  CustomerActivity,
  CustomerEntitlement,
  EntitlementEvent,
  EntitlementSource,
  Order,
} from '../../shared/types'
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

/** How long a grant or a revocation may explain itself for. */
const REASON_MAX = 200

/** Named because the dialog's submit button sits in the footer, outside it. */
const GRANT_FORM = 'grant-course'

/**
 * The two ways the shop hands a course over by hand.
 *
 * Not one action with a checkbox. "We gave this away" and "we failed to
 * deliver and put it right" are different claims about what happened, and the
 * accounts read differently for each — so the choice is made deliberately,
 * with what each one means written next to it.
 */
type GrantKind = 'gift' | 'manual'

const GRANT_KINDS: { value: GrantKind; label: string; hint: string }[] = [
  { value: 'gift', label: '贈送', hint: '主動送出的，例如客訴補償或推廣。永久觀看。' },
  { value: 'manual', label: '補發', hint: '會員本來就該有、但沒拿到的。可以照原方案設觀看天數。' },
]

/**
 * What the member's access amounts to, in the fewest words that are true.
 *
 * The four states are genuinely different things to somebody deciding what to
 * do next: taken away, run out, permanent, and timed but not yet started. That
 * last one is the one worth naming — a thirty-day course nobody has played yet
 * has no expiry date, and printing "永久" for it would be a lie the shop
 * would only find out about when the member complained.
 */
function accessState(entitlement: CustomerEntitlement): { tone: BadgeTone; label: string } {
  if (entitlement.revokedAt !== null) return { tone: 'danger', label: '已撤銷' }
  if (!entitlement.active) return { tone: 'neutral', label: '已到期' }
  if (entitlement.accessDays === null) return { tone: 'success', label: '永久' }
  if (entitlement.expiresAt === null) {
    return { tone: 'info', label: `${entitlement.accessDays} 天，尚未開始` }
  }
  return { tone: 'success', label: `至 ${dateOnly(entitlement.expiresAt)}` }
}

function sourceNote(source: EntitlementSource): string {
  return [source.actor, source.reason].filter(Boolean).join('・')
}

const ACTION_LABELS: Record<EntitlementEvent['action'], string> = {
  gift: '贈送',
  manual: '補發',
  revoke: '撤銷',
  restore: '恢復',
}

const SOURCE_LABELS: Record<EntitlementSource['kind'], string> = {
  purchase: '購買',
  gift: '贈送',
  manual: '補發',
}

/** What would still be holding this course up if that source went. */
function liveSourcesBesides(entitlement: CustomerEntitlement, source: EntitlementSource): number {
  return entitlement.sources.filter((other) => other.id !== source.id && other.revokedAt === null)
    .length
}

export function CustomerDetailPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<AdminCustomerDetail | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState<Draft | null>(null)
  const [access, setAccessList] = useState<CustomerEntitlement[] | null>(null)
  /** Only fetched when the gift dialog opens: nobody gifts on most visits. */
  const [courses, setCourses] = useState<Course[] | null>(null)
  const [grant, setGrant] = useState<
    { kind: GrantKind; courseId: string | null; reason: string; accessDays: string } | null
  >(null)
  const [revoking, setRevoking] = useState<
    { entitlement: CustomerEntitlement; source: EntitlementSource; reason: string } | null
  >(null)
  const [restoring, setRestoring] = useState<
    { entitlement: CustomerEntitlement; source: EntitlementSource; reason: string } | null
  >(null)
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

  // Its own request, and its own failure. A member whose course list cannot be
  // read is still a member whose address needs correcting.
  async function loadAccess() {
    try {
      const next = await api<{ entitlements: CustomerEntitlement[] }>(
        `/api/customers/${encodeURIComponent(id)}/entitlements`,
      )
      setAccessList(next.entitlements)
    } catch (error) {
      showError(error)
    }
  }

  useEffect(() => {
    void load()
    void loadAccess()
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

  async function openGrant() {
    setGrant({ kind: 'gift', courseId: null, reason: '', accessDays: '' })
    if (courses !== null) return
    try {
      // Published only. Granting a draft gives access to a course with nothing
      // in it, and an archived one is a course the shop has stopped teaching.
      setCourses((await api<{ courses: Course[] }>('/api/courses?status=published')).courses)
    } catch (error) {
      showError(error)
    }
  }

  async function grantCourse(event: Event) {
    event.preventDefault()
    const courseId = grant?.courseId
    const reason = grant?.reason.trim() ?? ''
    if (!grant || !courseId || !reason) return
    const days = grant.accessDays.trim()
    const ok = await run(async () => {
      const next = await apiJson<{ entitlements: CustomerEntitlement[] }>(
        `/api/customers/${encodeURIComponent(id)}/entitlements/${grant.kind === 'gift' ? 'gift' : 'grant'}`,
        'POST',
        // Blank days means permanent, which is an answer and not an omission.
        grant.kind === 'gift' ? { courseId, reason } : { courseId, reason, accessDays: days || null },
      )
      setAccessList(next.entitlements)
    }, grant.kind === 'gift' ? '課程已贈送。' : '課程已補發。')
    if (ok) setGrant(null)
  }

  async function revokeGift() {
    const target = revoking
    const reason = target?.reason.trim() ?? ''
    if (!target || !reason) return
    const ok = await run(async () => {
      const next = await apiJson<{ entitlements: CustomerEntitlement[] }>(
        `/api/customers/${encodeURIComponent(id)}/entitlements/revoke`,
        'POST',
        { sourceId: target.source.id, reason },
      )
      setAccessList(next.entitlements)
    }, '觀看權已撤銷。')
    if (ok) setRevoking(null)
  }

  async function restoreAccess() {
    const target = restoring
    const reason = target?.reason.trim() ?? ''
    if (!target || !reason) return
    const ok = await run(async () => {
      const next = await apiJson<{ entitlements: CustomerEntitlement[] }>(
        `/api/customers/${encodeURIComponent(id)}/entitlements/restore`,
        'POST',
        { sourceId: target.source.id, reason },
      )
      setAccessList(next.entitlements)
    }, '觀看權已恢復。')
    if (ok) setRestoring(null)
  }

  /** Courses they can already watch. Gifting one again would do nothing. */
  const held = new Set((access ?? []).filter((entry) => entry.active).map((entry) => entry.courseId))

  /**
   * When the course being restored has already run out anyway.
   *
   * Restoring does not reset the clock, so this is the case where the button
   * does exactly what it says and the member still sees nothing. Saying it
   * beforehand is the difference between a decision and a surprise.
   */
  const expiredAnyway =
    restoring !== null &&
    restoring.entitlement.expiresAt !== null &&
    restoring.entitlement.expiresAt * 1000 <= Date.now()
      ? restoring.entitlement.expiresAt
      : null

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

      <Modal
        title="授與課程"
        open={grant !== null}
        onClose={() => setGrant(null)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setGrant(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form={GRANT_FORM}
              tone="primary"
              busy={busy}
              disabled={!grant?.courseId || grant.reason.trim() === ''}
            >
              {grant?.kind === 'manual' ? '補發' : '贈送'}
            </Button>
          </>
        }
      >
        <form id={GRANT_FORM} onSubmit={grantCourse}>
          <RadioGroup
            legend="種類"
            value={grant?.kind ?? 'gift'}
            options={GRANT_KINDS}
            onChange={(kind) => grant && setGrant({ ...grant, kind })}
          />
          {/* Beside the fields rather than in the panel behind: this is the
              only moment anybody needs to know it. */}
          <p class="muted">
            兩種都不會建立訂單，也不會計入銷售數字。
            {grant?.kind === 'manual' &&
              '付款成功但沒開通的訂單請用訂單頁的「重新開通」，那條路才綁得回退款。'}
          </p>
          {courses === null ? (
            <Spinner />
          ) : (
            <Select
              label="課程"
              placeholder="選一門課"
              value={grant?.courseId ?? null}
              options={courses.map((course) => ({
                value: course.id,
                // Offered but unselectable, rather than missing: "why is that
                // course not in the list" is a worse question than seeing why.
                label: held.has(course.id) ? `${course.title}（已有觀看權）` : course.title,
                disabled: held.has(course.id),
              }))}
              onChange={(courseId) => grant && setGrant({ ...grant, courseId })}
            />
          )}
          {grant?.kind === 'manual' && (
            <TextField
              label="觀看天數"
              type="number"
              min={1}
              max={3650}
              hint="留空為永久。跟原本方案一樣就好；天數從會員第一次觀看才開始算。"
              value={grant.accessDays}
              onInput={(event) =>
                setGrant({ ...grant, accessDays: (event.currentTarget as HTMLInputElement).value })
              }
            />
          )}
          <TextField
            label="原因"
            hint="會記進稽核紀錄，顧客看不到。沒有原因的授與，日後沒有人能放心撤銷。"
            value={grant?.reason ?? ''}
            maxLength={REASON_MAX}
            required
            onInput={(event) =>
              grant && setGrant({ ...grant, reason: (event.currentTarget as HTMLInputElement).value })
            }
          />
        </form>
      </Modal>

      <Modal
        title={
          revoking
            ? `撤銷${SOURCE_LABELS[revoking.source.kind]}：${revoking.entitlement.courseTitle}`
            : ''
        }
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setRevoking(null)}>
              取消
            </Button>
            <Button
              tone="danger"
              busy={busy}
              disabled={(revoking?.reason.trim() ?? '') === ''}
              onClick={() => void revokeGift()}
            >
              撤銷
            </Button>
          </>
        }
      >
        {/* Says which of the two things this click does. Revoking a grant the
            member also paid for takes nothing away, and being surprised by
            that afterwards is how somebody ends up revoking twice. */}
        {revoking && liveSourcesBesides(revoking.entitlement, revoking.source) > 0 ? (
          <p>
            這門課還有 {liveSourcesBesides(revoking.entitlement, revoking.source)} 筆其他來源，
            撤銷這一筆之後會員仍然可以觀看。
          </p>
        ) : (
          <p>會員會立刻無法觀看這門課。學習進度會保留，之後可以從這裡恢復。</p>
        )}
        <TextField
          label="原因"
          hint="會記進稽核紀錄，顧客看不到。"
          value={revoking?.reason ?? ''}
          maxLength={REASON_MAX}
          required
          onInput={(event) =>
            revoking &&
            setRevoking({ ...revoking, reason: (event.currentTarget as HTMLInputElement).value })
          }
        />
      </Modal>

      <Modal
        title={restoring ? `恢復觀看權：${restoring.entitlement.courseTitle}` : ''}
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setRestoring(null)}>
              取消
            </Button>
            <Button
              tone="primary"
              busy={busy}
              disabled={(restoring?.reason.trim() ?? '') === ''}
              onClick={() => void restoreAccess()}
            >
              恢復觀看權
            </Button>
          </>
        }
      >
        {expiredAnyway !== null ? (
          <p>
            這門課的期限已經在 {dateOnly(expiredAnyway)} 到期，恢復之後會員還是看不到。
            恢復不會重新計算期限。
          </p>
        ) : (
          <p>
            會員會立刻恢復觀看。撤銷期間走掉的天數不會補回來 —— 恢復不重設期限，
            真的要延長必須是另一個決定。
          </p>
        )}
        {restoring?.source.revokeReason && (
          <p class="muted">當初撤銷的原因：{restoring.source.revokeReason}</p>
        )}
        <TextField
          label="原因"
          hint="會記進稽核紀錄，顧客看不到。"
          value={restoring?.reason ?? ''}
          maxLength={REASON_MAX}
          required
          onInput={(event) =>
            restoring &&
            setRestoring({ ...restoring, reason: (event.currentTarget as HTMLInputElement).value })
          }
        />
      </Modal>

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

            <Panel
              title="課程觀看權"
              actions={<Button onClick={() => void openGrant()}>授與課程</Button>}
            >
              {access === null ? (
                <Spinner />
              ) : access.length === 0 ? (
                <EmptyState
                  compact
                  title="還沒有任何課程"
                  body="會員買了課程之後會出現在這裡；也可以直接從上面贈送一門。"
                />
              ) : (
                <TableWrap>
                  <thead>
                    <tr><th>課程</th><th>觀看期限</th><th>授與時間</th><th>來源與紀錄</th></tr>
                  </thead>
                  <tbody>
                    {access.map((entitlement) => {
                      const state = accessState(entitlement)
                      return (
                        <tr key={entitlement.id}>
                          <td>{entitlement.courseTitle}</td>
                          <td><Badge tone={state.tone}>{state.label}</Badge></td>
                          <td>{dateOnly(entitlement.grantedAt)}</td>
                          <td>
                            {/* Every reason, not just the live ones. "Do they
                                still have access" and "what is still paying
                                for it" are different questions, and the
                                second is the one a refund argument turns on. */}
                            <ul class="entitlement-sources">
                              {entitlement.sources.map((source) => (
                                <li key={source.id}>
                                  <span class="entitlement-source-kind">
                                    {SOURCE_LABELS[source.kind]}
                                  </span>
                                  {sourceNote(source) && (
                                    <span class="muted">{sourceNote(source)}</span>
                                  )}
                                  {source.revokedAt !== null ? (
                                    <>
                                      <Badge tone="neutral">已撤銷</Badge>
                                      {source.revokeReason && (
                                        <span class="muted">{source.revokeReason}</span>
                                      )}
                                      {/* Any kind, unlike revoking: a purchase
                                          is taken back through the refund that
                                          justifies it, but a refund recorded
                                          against the wrong order is exactly
                                          what this is for. */}
                                      <Button
                                        tone="ghost"
                                        size="sm"
                                        aria-label={`恢復 ${entitlement.courseTitle} 的觀看權`}
                                        onClick={() => setRestoring({ entitlement, source, reason: '' })}
                                      >
                                        恢復
                                      </Button>
                                    </>
                                  ) : (
                                    // Not a purchase: that one is taken back by
                                    // recording the refund that justifies it,
                                    // and a button here would offer a way to
                                    // put access and money out of step.
                                    source.kind !== 'purchase' && (
                                      <Button
                                        tone="ghost"
                                        size="sm"
                                        aria-label={`撤銷 ${entitlement.courseTitle} 的${SOURCE_LABELS[source.kind]}`}
                                        onClick={() => setRevoking({ entitlement, source, reason: '' })}
                                      >
                                        撤銷
                                      </Button>
                                    )
                                  )}
                                </li>
                              ))}
                            </ul>
                            {/* What was decided about this course, which the
                                source rows above no longer say: restoring
                                clears the revocation off them. */}
                            {entitlement.history.length > 0 && (
                              <ol class="entitlement-history">
                                {entitlement.history.map((event) => (
                                  <li key={`${event.createdAt}-${event.action}`}>
                                    {dateOnly(event.createdAt)}・{ACTION_LABELS[event.action]}・
                                    {event.actor}
                                    {event.reason && `・${event.reason}`}
                                  </li>
                                ))}
                              </ol>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </TableWrap>
              )}
              {/* Only where it answers something. On an empty panel it is a
                  rule about a table that is not there. */}
              {access !== null && access.length > 0 && (
                <p class="muted">
                  購買來的觀看權由訂單的退款流程撤銷，這裡只能撤銷贈送與補發；被撤銷的都可以恢復。
                </p>
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
