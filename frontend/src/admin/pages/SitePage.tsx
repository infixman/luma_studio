import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { MenuEditor } from '../components/MenuEditor'
import { useStatus } from '../components/StatusBar'
import { SiteFooter, SiteHeader } from '../../shared/components/SiteChrome'
import { ApiError, api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { MenuItem, MenuState, SiteSettings } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'
import '../styles/pages-admin.css'
import '../styles/site-admin.css'

const COLOURS: { value: SiteSettings['headerColour']; label: string }[] = [
  { value: 'cream', label: '米白' },
  { value: 'sand', label: '沙' },
  { value: 'clay', label: '陶土' },
  { value: 'forest', label: '森綠' },
  { value: 'ink', label: '墨' },
]
const SIZES: { value: SiteSettings['headerHeight']; label: string }[] = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]
const EMPTY_ITEM = { label: '', targetKind: 'page' as MenuItem['targetKind'], target: '', parentId: '' }

/** Fixed sets, so these render as radio groups rather than as free fields. */
function Choice<T extends string>({
  legend,
  value,
  options,
  onPick,
}: {
  legend: string
  value: T
  options: { value: T; label: string }[]
  onPick: (next: T) => void
}) {
  return (
    <fieldset class="statuses choice-row">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} class="radio">
          <input type="radio" checked={value === option.value} onChange={() => onPick(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

export function SitePage() {
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState(EMPTY_ITEM)
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const load = useCallback(async () => {
    try {
      const [site, menuState] = await Promise.all([
        api<{ settings: SiteSettings }>('/api/site'),
        api<MenuState>('/api/menu'),
      ])
      setSettings(site.settings)
      setMenu(menuState)
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [showError])

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

  function edit(patch: Partial<SiteSettings>) {
    setSettings((current) => (current ? { ...current, ...patch } : current))
  }

  function saveSettings(event: Event) {
    event.preventDefault()
    if (!settings) return
    void run(async () => {
      const next = await apiJson<{ settings: SiteSettings }>('/api/site', 'PUT', settings)
      setSettings(next.settings)
    }, '外框設定已儲存。')
  }

  function addItem(event: Event) {
    event.preventDefault()
    void run(async () => {
      setMenu(
        await apiJson<MenuState>('/api/menu', 'POST', {
          label: draft.label,
          targetKind: draft.targetKind,
          target: draft.target,
          parentId: draft.parentId || null,
        }),
      )
      setDraft(EMPTY_ITEM)
    }, '選單項目已新增。')
  }

  function reorder(items: { id: string; parentId: string | null }[]) {
    void run(async () => setMenu(await apiJson<MenuState>('/api/menu/order', 'PUT', { items })), '選單已更新。')
  }

  function removeItem(item: MenuItem) {
    if (!confirm(`確定要刪除「${item.label}」？它底下的子項目也會一起刪除。`)) return
    void run(
      async () => setMenu(await api<MenuState>(`/api/menu/${encodeURIComponent(item.id)}`, { method: 'DELETE' })),
      '選單項目已刪除。',
    )
  }

  function editItem(item: MenuItem) {
    const label = prompt('選單文字', item.label)
    if (label === null) return
    void run(
      async () =>
        setMenu(
          await apiJson<MenuState>(`/api/menu/${encodeURIComponent(item.id)}`, 'PUT', {
            label,
            targetKind: item.targetKind,
            target: item.target,
          }),
        ),
      '選單項目已更新。',
    )
  }

  if (settings === null || menu === null) {
    return (
      <AdminShell current="/site" message={message} onError={showError}>
        <section class="stack shop">
          <div class="card">
            <p class="muted">載入中…</p>
          </div>
        </section>
      </AdminShell>
    )
  }

  return (
    <AdminShell current="/site" message={message} onError={showError}>
      <section class="stack shop">
        <div class="card">
          <h2>預覽</h2>
          <p class="muted">前台渲染外框的同一份程式，所以看到的就是網站上的樣子。</p>
          <div class="chrome-preview">
            <SiteHeader
              settings={settings}
              menu={menu.menu.map((item) => ({ id: item.id, parentId: item.parentId, label: item.label, href: '#' }))}
              cartCount={2}
            />
            <SiteFooter settings={settings} />
          </div>
        </div>

        <div class="card">
          <h2>選單</h2>
          <p class="muted">
            拖曳可以上下移動，⇤ ⇥ 改變層級，最多三層。按鈕在所有裝置上都能用——拖曳只在有滑鼠時方便。
          </p>
          <MenuEditor state={menu} busy={busy} onReorder={reorder} onEdit={editItem} onRemove={removeItem} />

          <form class="new-product menu-form" onSubmit={addItem}>
            <label>
              選單文字
              <input
                value={draft.label}
                onInput={(event) => setDraft({ ...draft, label: (event.target as HTMLInputElement).value })}
                maxLength={30}
                required
              />
            </label>
            <label>
              連到哪裡
              <select
                value={draft.targetKind}
                onChange={(event) =>
                  setDraft({ ...draft, targetKind: (event.target as HTMLSelectElement).value as MenuItem['targetKind'], target: '' })
                }
              >
                <option value="page">頁面</option>
                <option value="category">商品分類</option>
                <option value="url">外部網址</option>
              </select>
            </label>
            <label>
              目標
              {draft.targetKind === 'page' ? (
                <select
                  value={draft.target}
                  onChange={(event) => setDraft({ ...draft, target: (event.target as HTMLSelectElement).value })}
                  required
                >
                  <option value="">選一個頁面</option>
                  {menu.pages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                      {page.status === 'draft' ? '（草稿）' : ''}
                    </option>
                  ))}
                </select>
              ) : draft.targetKind === 'category' ? (
                <select
                  value={draft.target}
                  onChange={(event) => setDraft({ ...draft, target: (event.target as HTMLSelectElement).value })}
                  required
                >
                  <option value="">選一個分類</option>
                  {menu.categories.map((category) => (
                    <option key={category.slug} value={category.slug}>
                      {category.title}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="url"
                  placeholder="https://"
                  value={draft.target}
                  onInput={(event) => setDraft({ ...draft, target: (event.target as HTMLInputElement).value })}
                  required
                />
              )}
            </label>
            <button type="submit" disabled={busy || !draft.label.trim() || !draft.target}>
              新增項目
            </button>
          </form>
        </div>

        <div class="card">
          <h2>頁首</h2>
          <form class="product-form" onSubmit={saveSettings}>
            <Choice
              legend="背景"
              value={settings.headerBackground}
              options={[
                { value: 'solid', label: '純色' },
                { value: 'transparent', label: '透明' },
                { value: 'image', label: '圖片' },
              ]}
              onPick={(headerBackground) => edit({ headerBackground })}
            />
            <Choice legend="底色" value={settings.headerColour} options={COLOURS} onPick={(headerColour) => edit({ headerColour })} />
            <Choice legend="高度" value={settings.headerHeight} options={SIZES} onPick={(headerHeight) => edit({ headerHeight })} />
            <Choice
              legend="文字色"
              value={settings.headerText}
              options={[
                { value: 'dark', label: '深' },
                { value: 'light', label: '淺' },
              ]}
              onPick={(headerText) => edit({ headerText })}
            />
            <Choice
              legend="logo 大小"
              value={settings.headerLogoSize}
              options={SIZES}
              onPick={(headerLogoSize) => edit({ headerLogoSize })}
            />

            <label class="toggle">
              <input
                type="checkbox"
                checked={settings.headerSticky}
                onChange={(event) => edit({ headerSticky: (event.target as HTMLInputElement).checked })}
              />
              捲動時固定在頂端
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settings.headerShowCart}
                onChange={(event) => edit({ headerShowCart: (event.target as HTMLInputElement).checked })}
              />
              顯示購物車
            </label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settings.headerShowLogin}
                onChange={(event) => edit({ headerShowLogin: (event.target as HTMLInputElement).checked })}
              />
              顯示登入入口
            </label>

            <label>
              行動呼籲按鈕文字
              <input
                value={settings.headerCtaLabel}
                onInput={(event) => edit({ headerCtaLabel: (event.target as HTMLInputElement).value })}
                maxLength={20}
                placeholder="留空就不顯示"
              />
            </label>
            <label>
              按鈕連結
              <input
                type="url"
                value={settings.headerCtaUrl}
                onInput={(event) => edit({ headerCtaUrl: (event.target as HTMLInputElement).value })}
                placeholder="https://"
              />
            </label>

            <button type="submit" disabled={busy}>
              儲存頁首
            </button>
          </form>
        </div>

        <div class="card">
          <h2>頁尾</h2>
          <form class="product-form" onSubmit={saveSettings}>
            <Choice legend="底色" value={settings.footerColour} options={COLOURS} onPick={(footerColour) => edit({ footerColour })} />
            <Choice
              legend="文字色"
              value={settings.footerText}
              options={[
                { value: 'dark', label: '深' },
                { value: 'light', label: '淺' },
              ]}
              onPick={(footerText) => edit({ footerText })}
            />
            <label>
              版權文字
              <input
                value={settings.footerCopyright}
                onInput={(event) => edit({ footerCopyright: (event.target as HTMLInputElement).value })}
                maxLength={200}
                placeholder="© 2026 苒光繪誌"
              />
            </label>
            <button type="submit" disabled={busy}>
              儲存頁尾
            </button>
          </form>
        </div>
      </section>
    </AdminShell>
  )
}
