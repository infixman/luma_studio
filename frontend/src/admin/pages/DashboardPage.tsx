import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Badge, EmptyState, Panel, Spinner, TableWrap } from '../components/ui'
import { STOREFRONT_ORIGIN, api } from '../../shared/api'
import type { DashboardSummary } from '../../shared/types'
import '../styles/dashboard.css'

/**
 * What the shop looks like this morning.
 *
 * The back office used to open on the ibon print tool, which is a tool — and
 * a tool is not an answer to "what needs me today". These four panels are the
 * questions the owner actually arrives with, in the order they matter:
 * somebody is waiting for a parcel, something is about to sell out, this is
 * what the month did, this is what I was in the middle of.
 */

function ago(seconds: number): string {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60))
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  return `${Math.round(hours / 24)} 天前`
}

export function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [failed, setFailed] = useState(false)
  const { message, showError } = useStatus()

  const load = useCallback(async () => {
    try {
      setSummary(await api<DashboardSummary>('/api/dashboard'))
    } catch (error) {
      setFailed(true)
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  if (failed) {
    return (
      <AdminShell current="/" message={message} onError={showError}>
        <EmptyState title="讀不到目前的狀態" body="重新整理再試一次。其他頁面不受影響。" />
      </AdminShell>
    )
  }
  if (summary === null) {
    return (
      <AdminShell current="/" message={message} onError={showError}>
        <Spinner />
      </AdminShell>
    )
  }

  const { orders, revenue, lowStock, recentPages } = summary

  return (
    <AdminShell current="/" message={message} onError={showError}>
      {/* The one number worth acting on today goes first and biggest. */}
      <div class="stat-row">
        <a class={orders.waiting > 0 ? 'stat is-urgent' : 'stat'} href="/orders">
          <span class="stat-value">{orders.waiting}</span>
          <span class="stat-label">已付款、還沒出貨</span>
        </a>
        <a class="stat" href="/orders">
          <span class="stat-value">{orders.pending}</span>
          <span class="stat-label">等待付款</span>
        </a>
        <div class="stat">
          <span class="stat-value">NT${revenue.total.toLocaleString('zh-TW')}</span>
          <span class="stat-label">近 30 天收款．{revenue.orders} 筆</span>
        </div>
        <a class="stat" href="/products">
          <span class="stat-value">{lowStock.length}</span>
          <span class="stat-label">庫存吃緊的規格</span>
        </a>
      </div>

      <div class="dashboard-split">
        <Panel title="快要賣完">
          {lowStock.length === 0 ? (
            <EmptyState title="沒有快賣完的東西" body={`上架中的規格庫存都還在 ${summary.lowStockAt} 件以上。`} />
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th>商品</th>
                  <th>規格</th>
                  <th class="numeric">剩餘</th>
                </tr>
              </thead>
              <tbody>
                {lowStock.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <a href={`${STOREFRONT_ORIGIN}/shop/${encodeURIComponent(item.slug)}`} target="_blank" rel="noopener">
                        {item.productTitle}
                      </a>
                    </td>
                    <td>{item.variantTitle}</td>
                    <td class="numeric">
                      {/* Zero is a different problem from nearly-zero: one is
                          "restock soon", the other is "customers are being
                          turned away right now". */}
                      <Badge tone={item.stock === 0 ? 'danger' : 'warning'}>{item.stock}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Panel>

        <Panel title="最近編輯過的頁面">
          {recentPages.length === 0 ? (
            <EmptyState title="最近沒有動過頁面" body="這兩週編輯過的頁面會出現在這裡，方便接著做。" />
          ) : (
            <ul class="recent-list">
              {recentPages.map((page) => (
                <li key={page.id}>
                  <a href={`/pages/${encodeURIComponent(page.id)}`}>{page.title}</a>
                  <code>{page.path}</code>
                  {page.status === 'published' ? <Badge tone="success">公開</Badge> : <Badge>草稿</Badge>}
                  <span class="when">{ago(page.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </AdminShell>
  )
}
