import { useCallback, useEffect, useId, useState } from 'preact/hooks'

import { AdminShell } from '../../components/AdminShell'
import { MenuEditor } from '../../components/MenuEditor'
import { useStatus } from '../../components/StatusBar'
import { Button, Modal, Panel, Spinner, TextField, useConfirm } from '../../components/ui'
import { SiteFooter, SiteHeader } from '../../../shared/components/SiteChrome'
import { socialPlatforms } from '../../../shared/components/SocialIcon'
import { api, apiJson, apiUrl, uploadHeaderImage } from '../../../shared/api'
import type { MenuItem, MenuState, SiteSettings } from '../../../shared/types'
import { FOOTER_COLUMN_MAX, FOOTER_LINK_MAX } from './constraints'
import '../../styles/pages-admin.css'
import '../../styles/site-admin.css'

const COLOURS: { value: SiteSettings['headerColour']; label: string; swatch: string }[] = [
  { value: 'cream', label: '米白', swatch: 'cream' },
  { value: 'sand', label: '沙', swatch: 'sand' },
  { value: 'clay', label: '陶土', swatch: 'clay' },
  { value: 'forest', label: '森綠', swatch: 'forest' },
  { value: 'ink', label: '墨', swatch: 'ink' },
]
const SIZES: { value: SiteSettings['headerHeight']; label: string }[] = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]
const EMPTY_ITEM = { label: '', targetKind: 'page' as MenuItem['targetKind'], target: '', parentId: '' }

/** Fixed choices use a compact segmented control; the native radios remain
 * underneath for keyboard navigation and form semantics. */
function Choice<T extends string>({
  legend,
  value,
  options,
  onPick,
}: {
  legend: string
  value: T
  options: { value: T; label: string; swatch?: string; colour?: string }[]
  onPick: (next: T) => void
}) {
  const name = useId()
  return (
    <fieldset class="site-choice">
      <legend class="ui-label">{legend}</legend>
      <div class="site-choice-options">
        {options.map((option) => {
          const id = `${name}-${option.value}`
          return (
            <span class="site-choice-option" key={option.value}>
              <input
                id={id}
                class="site-choice-input"
                type="radio"
                name={name}
                checked={option.value === value}
                onChange={() => onPick(option.value)}
              />
              <label class="site-choice-label" for={id}>
                {(option.swatch || option.colour) && (
                  <span
                    class={['site-colour-swatch', option.swatch ? `is-${option.swatch}` : ''].filter(Boolean).join(' ')}
                    style={option.colour ? { backgroundColor: option.colour } : undefined}
                    aria-hidden="true"
                  />
                )}
                {option.label}
              </label>
            </span>
          )
        })}
      </div>
    </fieldset>
  )
}

export function SitePage() {
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [savedSettings, setSavedSettings] = useState<SiteSettings | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState(EMPTY_ITEM)
  const [savingSection, setSavingSection] = useState<'header' | 'footer' | null>(null)
  const [collapsed, setCollapsed] = useState({ menu: false, header: false, footer: false })
  /** The item being renamed, and what it is being renamed to. Null when closed. */
  const [renaming, setRenaming] = useState<{ item: MenuItem; label: string } | null>(null)
  const { message, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      const [site, menuState] = await Promise.all([
        api<{ settings: SiteSettings }>('/api/site'),
        api<MenuState>('/api/menu'),
      ])
      setSettings(site.settings)
      setSavedSettings(site.settings)
      setMenu(menuState)
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  function edit(patch: Partial<SiteSettings>) {
    setSettings((current) => (current ? { ...current, ...patch } : current))
  }

  function pickHeaderImage(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    void run(async () => {
      const next = await uploadHeaderImage(file)
      // Only the path. The response carries the *saved* settings, and taking
      // all of it would throw away whatever the owner has changed above but
      // not saved yet — including the "background: image" that put this
      // control on screen.
      edit({ headerImagePath: next.settings.headerImagePath })
      input.value = ''
    }, '頁首背景圖已更新。')
  }

  function removeHeaderImage() {
    void run(async () => {
      await api<{ settings: SiteSettings }>('/api/site/header-image', { method: 'DELETE' })
      edit({ headerImagePath: null })
    }, '頁首背景圖已移除。')
  }

  /* These read the settings out of the updater rather than out of the render
     that drew the field. Two edits inside one frame — a label and a URL
     pasted together — would otherwise both be computed from the same starting
     point, and the second would undo the first. */

  function editColumn(index: number, patch: Partial<SiteSettings['footerColumns'][number]>) {
    setSettings((current) =>
      current
        ? {
            ...current,
            footerColumns: current.footerColumns.map((column, at) => (at === index ? { ...column, ...patch } : column)),
          }
        : current,
    )
  }

  function editLink(columnIndex: number, linkIndex: number, patch: Partial<{ label: string; url: string }>) {
    setSettings((current) => {
      if (!current) return current
      return {
        ...current,
        footerColumns: current.footerColumns.map((column, at) =>
          at === columnIndex
            ? { ...column, links: column.links.map((link, on) => (on === linkIndex ? { ...link, ...patch } : link)) }
            : column,
        ),
      }
    })
  }

  function editSocial(index: number, patch: Partial<{ platform: string; url: string }>) {
    setSettings((current) =>
      current
        ? {
            ...current,
            footerSocials: current.footerSocials.map((social, at) => (at === index ? { ...social, ...patch } : social)),
          }
        : current,
    )
  }

  function saveSettings(event: Event) {
    event.preventDefault()
    if (!settings) return
    const section = (event.currentTarget as HTMLFormElement).id === 'site-header-settings' ? 'header' : 'footer'
    setSavingSection(section)
    void run(async () => {
      const next = await apiJson<{ settings: SiteSettings }>('/api/site', 'PUT', settings)
      setSettings(next.settings)
      setSavedSettings(next.settings)
    }, '外框設定已儲存。').finally(() => setSavingSection(null))
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

  async function removeItem(item: MenuItem) {
    const ok = await ask({
      title: '刪除選單項目',
      body: (
        <>
          <p>確定要刪除「{item.label}」嗎？</p>
          <p>它底下的子項目會一起刪除。</p>
        </>
      ),
      confirmLabel: '刪除',
    })
    if (!ok) return
    void run(
      async () => setMenu(await api<MenuState>(`/api/menu/${encodeURIComponent(item.id)}`, { method: 'DELETE' })),
      '選單項目已刪除。',
    )
  }

  /**
   * Renaming was a `prompt()` — the last one in the codebase.
   *
   * Beyond looking like the operating system, that box cannot say how long a
   * label may be, cannot show the one that is being replaced next to the one
   * being typed, and cannot be cancelled with anything but its own button.
   */
  function editItem(item: MenuItem) {
    setRenaming({ item, label: item.label })
  }

  function commitRename() {
    const pending = renaming
    if (!pending) return
    const label = pending.label.trim()
    if (!label) return
    setRenaming(null)
    void run(
      async () =>
        setMenu(
          await apiJson<MenuState>(`/api/menu/${encodeURIComponent(pending.item.id)}`, 'PUT', {
            label,
            targetKind: pending.item.targetKind,
            target: pending.item.target,
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
            <Spinner />
          </div>
        </section>
      </AdminShell>
    )
  }

  const headerDirty = savedSettings !== null && (
    settings.headerBackground !== savedSettings.headerBackground ||
    settings.headerColour !== savedSettings.headerColour ||
    settings.headerCustomColour !== savedSettings.headerCustomColour ||
    settings.headerHeight !== savedSettings.headerHeight ||
    settings.headerText !== savedSettings.headerText ||
    settings.headerLogoSize !== savedSettings.headerLogoSize ||
    settings.headerSticky !== savedSettings.headerSticky ||
    settings.headerShowCart !== savedSettings.headerShowCart ||
    settings.headerShowLogin !== savedSettings.headerShowLogin ||
    settings.headerCtaLabel !== savedSettings.headerCtaLabel ||
    settings.headerCtaUrl !== savedSettings.headerCtaUrl ||
    settings.headerImagePath !== savedSettings.headerImagePath
  )
  const footerDirty = savedSettings !== null && (
    settings.footerColour !== savedSettings.footerColour ||
    settings.footerText !== savedSettings.footerText ||
    settings.footerCustomColour !== savedSettings.footerCustomColour ||
    settings.footerCustomText !== savedSettings.footerCustomText ||
    settings.footerBlurb !== savedSettings.footerBlurb ||
    settings.footerCopyright !== savedSettings.footerCopyright ||
    JSON.stringify(settings.footerColumns) !== JSON.stringify(savedSettings.footerColumns) ||
    JSON.stringify(settings.footerSocials) !== JSON.stringify(savedSettings.footerSocials)
  )

  return (
    <AdminShell current="/site" message={message} onError={showError}>
      {dialog}

      <Modal
        title="改選單文字"
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button tone="primary" disabled={!renaming?.label.trim()} onClick={commitRename}>
              儲存
            </Button>
          </>
        }
      >
        <TextField
          label="選單文字"
          value={renaming?.label ?? ''}
          maxLength={30}
          hint={renaming ? `原本是「${renaming.item.label}」` : undefined}
          onInput={(event) =>
            setRenaming((current) =>
              current ? { ...current, label: (event.currentTarget as HTMLInputElement).value } : current,
            )
          }
        />
      </Modal>

      <section class="stack shop">
        <Panel title="預覽">
          <p class="muted">前台渲染外框的同一份程式，所以看到的就是網站上的樣子。</p>
          <div class="chrome-preview">
            <SiteHeader
              settings={settings}
              menu={menu.menu.map((item) => ({
                id: item.id,
                parentId: item.parentId,
                label: item.label,
                href: item.targetKind === 'parent' ? null : '#',
              }))}
              cartCount={2}
            />
            <SiteFooter settings={settings} />
          </div>
        </Panel>

        <Panel
          title="選單"
          collapsed={collapsed.menu}
          onCollapsedChange={(menu) => setCollapsed((current) => ({ ...current, menu }))}
        >
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
                <option value="parent">父選單（無連結）</option>
                <option value="page">頁面</option>
                <option value="category">商品分類</option>
                <option value="url">外部網址</option>
              </select>
            </label>
            {draft.targetKind === 'parent' ? (
              <div class="menu-parent-target">
                <span>目標</span>
                <strong>無連結，只用來收納子項目</strong>
              </div>
            ) : (
              <label>
                目標
                {draft.targetKind === 'page' ? (
                  <select
                    value={draft.target}
                    onChange={(event) =>
                      setDraft({ ...draft, target: (event.target as HTMLSelectElement).value })
                    }
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
                    onChange={(event) =>
                      setDraft({ ...draft, target: (event.target as HTMLSelectElement).value })
                    }
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
                    onInput={(event) =>
                      setDraft({ ...draft, target: (event.target as HTMLInputElement).value })
                    }
                    required
                  />
                )}
              </label>
            )}
            <button
              type="submit"
              disabled={busy || !draft.label.trim() || (draft.targetKind !== 'parent' && !draft.target)}
            >
              新增項目
            </button>
          </form>
        </Panel>

        <Panel
          title="頁首"
          collapsed={collapsed.header}
          onCollapsedChange={(header) => setCollapsed((current) => ({ ...current, header }))}
          actions={
            <Button
              type="submit"
              form="site-header-settings"
              tone="primary"
              busy={savingSection === 'header'}
              disabled={busy || !headerDirty}
            >
              儲存頁首
            </Button>
          }
        >
          <form id="site-header-settings" class="site-settings-form" onSubmit={saveSettings}>
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
            {/* Only shown for the background that uses it: an upload control
                beside a solid colour is a control that appears to do nothing. */}
            {settings.headerBackground === 'image' && (
              <div class="header-image-row">
                {settings.headerImagePath ? (
                  <img class="thumb" src={apiUrl(settings.headerImagePath)} alt="目前的頁首背景" />
                ) : (
                  <span class="thumb empty">還沒有背景圖</span>
                )}
                <div class="controls">
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={pickHeaderImage} disabled={busy} />
                  {settings.headerImagePath && (
                    <button type="button" class="danger" disabled={busy} onClick={removeHeaderImage}>
                      移除背景圖
                    </button>
                  )}
                </div>
              </div>
            )}
            {settings.headerBackground === 'solid' && (
              <>
                <Choice
                  legend="底色"
                  value={settings.headerColour}
                  options={[
                    ...COLOURS,
                    { value: 'custom', label: '自訂', colour: settings.headerCustomColour },
                  ]}
                  onPick={(headerColour) => edit({ headerColour })}
                />
                {settings.headerColour === 'custom' && (
                  <label class="site-custom-colour">
                    <span>自訂底色</span>
                    <input
                      type="color"
                      value={settings.headerCustomColour}
                      onInput={(event) =>
                        edit({ headerCustomColour: (event.currentTarget as HTMLInputElement).value })
                      }
                    />
                    <code>{settings.headerCustomColour.toUpperCase()}</code>
                  </label>
                )}
              </>
            )}
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

          </form>
        </Panel>

        <Panel
          title="頁尾"
          collapsed={collapsed.footer}
          onCollapsedChange={(footer) => setCollapsed((current) => ({ ...current, footer }))}
          actions={
            <Button
              type="submit"
              form="site-footer-settings"
              tone="primary"
              busy={savingSection === 'footer'}
              disabled={busy || !footerDirty}
            >
              儲存頁尾
            </Button>
          }
        >
          <form id="site-footer-settings" class="site-settings-form" onSubmit={saveSettings}>
            <Choice
              legend="底色"
              value={settings.footerColour}
              options={[
                ...COLOURS,
                { value: 'custom', label: '自訂', colour: settings.footerCustomColour },
              ]}
              onPick={(footerColour) => edit({ footerColour })}
            />
            {settings.footerColour === 'custom' && (
              <label class="site-custom-colour">
                <span>自訂底色</span>
                <input
                  type="color"
                  value={settings.footerCustomColour}
                  onInput={(event) =>
                    edit({ footerCustomColour: (event.currentTarget as HTMLInputElement).value })
                  }
                />
                <code>{settings.footerCustomColour.toUpperCase()}</code>
              </label>
            )}
            <Choice
              legend="文字色"
              value={settings.footerText}
              options={[
                { value: 'dark', label: '深', colour: '#2b2622' },
                { value: 'light', label: '淺', colour: '#f3efe9' },
                { value: 'custom', label: '自訂', colour: settings.footerCustomText },
              ]}
              onPick={(footerText) => edit({ footerText })}
            />
            {settings.footerText === 'custom' && (
              <label class="site-custom-colour">
                <span>自訂文字色</span>
                <input
                  type="color"
                  value={settings.footerCustomText}
                  onInput={(event) =>
                    edit({ footerCustomText: (event.currentTarget as HTMLInputElement).value })
                  }
                />
                <code>{settings.footerCustomText.toUpperCase()}</code>
              </label>
            )}
            <h3>品牌欄</h3>
            <p class="muted">頁尾左邊的那一塊：logo、一句話、版權。連結欄位會靠右排。</p>
            <label>
              一句話介紹
              <input
                value={settings.footerBlurb}
                onInput={(event) => edit({ footerBlurb: (event.target as HTMLInputElement).value })}
                maxLength={200}
                placeholder="台中的插畫工作室，把日常畫成可以帶走的東西。"
              />
            </label>
            <label>
              版權文字
              <input
                value={settings.footerCopyright}
                onInput={(event) => edit({ footerCopyright: (event.target as HTMLInputElement).value })}
                maxLength={200}
                placeholder="© 2026 苒光繪誌"
              />
            </label>

            <h3>連結欄位</h3>
            <p class="muted">服務條款、退換貨政策、隱私權政策這類頁面放這裡。最多 {FOOTER_COLUMN_MAX} 欄，每欄 {FOOTER_LINK_MAX} 個連結。</p>
            <ul class="footer-columns-editor">
              {settings.footerColumns.map((column, columnIndex) => (
                <li key={columnIndex}>
                  <div class="column-head">
                    <input
                      placeholder="欄位標題"
                      maxLength={40}
                      value={column.title}
                      onInput={(event) => editColumn(columnIndex, { title: (event.target as HTMLInputElement).value })}
                    />
                    <button
                      type="button"
                      class="danger"
                      onClick={() => edit({ footerColumns: settings.footerColumns.filter((_, at) => at !== columnIndex) })}
                    >
                      刪除這一欄
                    </button>
                  </div>
                  <ul class="link-list">
                    {column.links.map((link, linkIndex) => (
                      <li key={linkIndex}>
                        <input
                          placeholder="文字"
                          maxLength={40}
                          value={link.label}
                          onInput={(event) => editLink(columnIndex, linkIndex, { label: (event.target as HTMLInputElement).value })}
                        />
                        <input
                          type="url"
                          placeholder="https://"
                          value={link.url}
                          onInput={(event) => editLink(columnIndex, linkIndex, { url: (event.target as HTMLInputElement).value })}
                        />
                        <button
                          type="button"
                          class="danger"
                          onClick={() => editColumn(columnIndex, { links: column.links.filter((_, at) => at !== linkIndex) })}
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={column.links.length >= FOOTER_LINK_MAX}
                    onClick={() => editColumn(columnIndex, { links: [...column.links, { label: '', url: '' }] })}
                  >
                    加一個連結
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={settings.footerColumns.length >= FOOTER_COLUMN_MAX}
              onClick={() => edit({ footerColumns: [...settings.footerColumns, { title: '', links: [] }] })}
            >
              加一欄
            </button>

            <h3>社群連結</h3>
            <ul class="link-list">
              {settings.footerSocials.map((social, index) => (
                <li key={index}>
                  <select
                    value={social.platform}
                    onChange={(event) => editSocial(index, { platform: (event.target as HTMLSelectElement).value })}
                  >
                    {socialPlatforms.map((platform) => (
                      <option key={platform.value} value={platform.value}>
                        {platform.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="url"
                    placeholder="https://"
                    value={social.url}
                    onInput={(event) => editSocial(index, { url: (event.target as HTMLInputElement).value })}
                  />
                  <button
                    type="button"
                    class="danger"
                    onClick={() => edit({ footerSocials: settings.footerSocials.filter((_, at) => at !== index) })}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={settings.footerSocials.length >= 10}
              onClick={() => edit({ footerSocials: [...settings.footerSocials, { platform: 'instagram', url: '' }] })}
            >
              加一個社群連結
            </button>

          </form>
        </Panel>
      </section>
    </AdminShell>
  )
}
