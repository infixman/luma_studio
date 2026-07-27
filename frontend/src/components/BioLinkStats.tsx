import { useEffect, useState } from 'preact/hooks'

import { api } from '../lib/api'
import type { BioLinkStats as Stats, LabelledTotal } from '../lib/types'

const RANGES = [7, 30, 90]

const deviceLabels: Record<string, string> = { mobile: '手機', tablet: '平板', desktop: '電腦' }

function Breakdown({ title, rows, empty, translate }: { title: string; rows: LabelledTotal[]; empty: string; translate?: Record<string, string> }) {
  const max = rows.reduce((highest, row) => Math.max(highest, row.total), 0)
  return (
    <div class="stat-breakdown">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p class="muted">{empty}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.label}>
              <span class="stat-label">{translate?.[row.label] ?? row.label}</span>
              <span class="stat-bar" style={{ width: `${max ? (row.total / max) * 100 : 0}%` }} />
              <span class="stat-total">{row.total}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function BioLinkStatsPanel({ onError }: { onError: (error: unknown) => void }) {
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    let cancelled = false
    setStats(null)
    api<Stats>(`/api/admin/bio-link/stats?days=${days}`)
      .then((data) => {
        if (!cancelled) setStats(data)
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error)
      })
    return () => {
      cancelled = true
    }
  }, [days, onError])

  const peak = stats ? stats.daily.reduce((highest, entry) => Math.max(highest, entry.views, entry.clicks), 0) : 0

  return (
    <section class="stats">
      <div class="stats-head">
        <div>
          <h3>造訪統計</h3>
          <p class="muted">數字是「不重複訪客」：同一人同一天對同一個目標只算一次。</p>
        </div>
        <div class="stats-ranges">
          {RANGES.map((range) => (
            <button key={range} class={range === days ? 'choice selected' : 'choice'} onClick={() => setDays(range)}>
              {range} 天
            </button>
          ))}
        </div>
      </div>

      {stats === null ? (
        <p class="muted">載入中…</p>
      ) : (
        <>
          <div class="stat-totals">
            <div>
              <strong>{stats.views}</strong>
              <span class="muted">頁面瀏覽</span>
            </div>
            <div>
              <strong>{stats.clicks}</strong>
              <span class="muted">連結點擊</span>
            </div>
            <div>
              <strong>{stats.views ? `${Math.round((stats.clicks / stats.views) * 100)}%` : '—'}</strong>
              <span class="muted">點擊率</span>
            </div>
          </div>

          {stats.daily.length === 0 ? (
            <p class="muted">這段期間還沒有資料。連結分享出去之後就會開始累積。</p>
          ) : (
            <div class="stat-chart" role="img" aria-label={`每日瀏覽與點擊，自 ${stats.since} 起`}>
              {stats.daily.map((entry) => (
                <div key={entry.day} class="stat-day" title={`${entry.day}：瀏覽 ${entry.views}、點擊 ${entry.clicks}`}>
                  <span class="stat-day-views" style={{ height: `${peak ? (entry.views / peak) * 100 : 0}%` }} />
                  <span class="stat-day-clicks" style={{ height: `${peak ? (entry.clicks / peak) * 100 : 0}%` }} />
                </div>
              ))}
            </div>
          )}

          {stats.items.length > 0 && (
            <div class="stat-breakdown">
              <h4>各連結點擊</h4>
              <ul>
                {stats.items.map((item) => (
                  <li key={item.id}>
                    <span class="stat-label">{item.title}</span>
                    <span
                      class="stat-bar"
                      style={{ width: `${stats.items[0]!.total ? (item.total / stats.items[0]!.total) * 100 : 0}%` }}
                    />
                    <span class="stat-total">{item.total}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div class="stat-columns">
            <Breakdown title="國家" rows={stats.countries} empty="尚無資料" />
            <Breakdown title="來源網站" rows={stats.referrers} empty="多數是直接開啟" />
            <Breakdown title="裝置" rows={stats.devices} empty="尚無資料" translate={deviceLabels} />
          </div>
        </>
      )}
    </section>
  )
}
