import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../../components/AdminShell'
import { MenuEditor } from '../../components/MenuEditor'
import { useStatus } from '../../components/StatusBar'
import {
  Button,
  Checkbox,
  ColourPicker,
  Menu,
  MenuItem as MenuAction,
  Modal,
  Panel,
  RadioGroup,
  Section,
  Select,
  Spinner,
  TextField,
  useConfirm,
} from '../../components/ui'
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

/** Named because the submit button sits in the dialog's own footer. */
const ADD_ITEM_FORM = 'new-menu-item'

const TARGET_KINDS: { value: MenuItem['targetKind']; label: string }[] = [
  { value: 'parent', label: '父選單（無連結）' },
  { value: 'page', label: '頁面' },
  { value: 'category', label: '商品分類' },
  { value: 'url', label: '外部網址' },
]

/* This page had its own `Choice` — a segmented radio group with colour
   swatches — sitting beside the shared RadioGroup that does the same job.
   The swatch is the only thing it had that the shared one did not, so that
   moved across and this one went. */

export function SitePage() {
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [savedSettings, setSavedSettings] = useState<SiteSettings | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [draft, setDraft] = useState(EMPTY_ITEM)
  const [savingSection, setSavingSection] = useState<'header' | 'footer' | null>(null)
  const [addingItem, setAddingItem] = useState(false)
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

  function editLink(
    columnIndex: number,
    linkIndex: number,
    patch: Partial<{ label: string; url: string; newTab: boolean }>,
  ) {
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

  function editSocial(index: number, patch: Partial<{ platform: string; url: string; newTab: boolean }>) {
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
      setAddingItem(false)
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
          <Panel>
            <Spinner />
          </Panel>
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
    settings.headerCustomText !== savedSettings.headerCustomText ||
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

      <Modal
        title="新增選單項目"
        open={addingItem}
        onClose={() => setAddingItem(false)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setAddingItem(false)}>
              取消
            </Button>
            <Button
              type="submit"
              form={ADD_ITEM_FORM}
              tone="primary"
              busy={busy}
              disabled={!draft.label.trim() || (draft.targetKind !== 'parent' && !draft.target)}
            >
              新增
            </Button>
          </>
        }
      >
        <form id={ADD_ITEM_FORM} onSubmit={addItem}>
          <TextField
            label="選單文字"
            value={draft.label}
            maxLength={30}
            required
            onInput={(event) => setDraft({ ...draft, label: (event.currentTarget as HTMLInputElement).value })}
          />
          <Select
            label="連到哪裡"
            value={draft.targetKind}
            options={TARGET_KINDS}
            onChange={(targetKind) => setDraft({ ...draft, targetKind, target: '' })}
          />
          {draft.targetKind === 'page' && (
            <Select
              label="目標頁面"
              value={draft.target || null}
              placeholder="選一個頁面"
              options={menu.pages.map((page) => ({
                value: page.id,
                label: `${page.title}${page.status === 'draft' ? '（草稿）' : ''}`,
              }))}
              onChange={(target) => setDraft({ ...draft, target })}
            />
          )}
          {draft.targetKind === 'category' && (
            <Select
              label="目標分類"
              value={draft.target || null}
              placeholder="選一個分類"
              options={menu.categories.map((category) => ({ value: category.slug, label: category.title }))}
              onChange={(target) => setDraft({ ...draft, target })}
            />
          )}
          {draft.targetKind === 'url' && (
            <TextField
              label="外部網址"
              type="url"
              placeholder="https://"
              value={draft.target}
              required
              onInput={(event) => setDraft({ ...draft, target: (event.currentTarget as HTMLInputElement).value })}
            />
          )}
          {draft.targetKind === 'parent' && <p class="muted">沒有連結，只用來收納子項目。</p>}
        </form>
      </Modal>

      <section class="stack shop">
        <Panel title="預覽">
          <div class="chrome-preview">
            <SiteHeader
              preview
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
          actions={
            <Button tone="primary" size="sm" onClick={() => setAddingItem(true)}>
              新增項目
            </Button>
          }
        >
          <p class="muted">拖曳可以上下移動，⇤ ⇥ 改變層級，最多三層。</p>
          <MenuEditor state={menu} busy={busy} onReorder={reorder} onEdit={editItem} onRemove={removeItem} />
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
            <RadioGroup
              legend="背景"
              inline
              value={settings.headerBackground}
              options={[
                { value: 'solid', label: '純色' },
                { value: 'transparent', label: '透明' },
                { value: 'image', label: '圖片' },
              ]}
              onChange={(headerBackground) => edit({ headerBackground })}
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
                    <Button tone="danger" size="sm" disabled={busy} onClick={removeHeaderImage}>
                      移除背景圖
                    </Button>
                  )}
                </div>
              </div>
            )}
            {settings.headerBackground === 'solid' && (
              <>
                <RadioGroup
                  legend="底色"
                  inline
                  value={settings.headerColour}
                  options={[
                    ...COLOURS,
                    { value: 'custom', label: '自訂', colour: settings.headerCustomColour },
                  ]}
                  onChange={(headerColour) => edit({ headerColour })}
                />
                {settings.headerColour === 'custom' && (
                  <ColourPicker
                    label="自訂底色"
                    value={settings.headerCustomColour}
                    onChange={(headerCustomColour) => edit({ headerCustomColour })}
                  />
                )}
              </>
            )}
            <RadioGroup
              legend="高度"
              inline
              value={settings.headerHeight}
              options={SIZES}
              onChange={(headerHeight) => edit({ headerHeight })}
            />
            <RadioGroup
              legend="文字色"
              inline
              value={settings.headerText}
              options={[
                { value: 'dark', label: '深', colour: '#2b2622' },
                { value: 'light', label: '淺', colour: '#f3efe9' },
                { value: 'custom', label: '自訂', colour: settings.headerCustomText },
              ]}
              onChange={(headerText) => edit({ headerText })}
            />
            {settings.headerText === 'custom' && (
              <ColourPicker
                label="自訂文字色"
                value={settings.headerCustomText}
                onChange={(headerCustomText) => edit({ headerCustomText })}
              />
            )}
            <RadioGroup
              legend="logo 大小"
              inline
              value={settings.headerLogoSize}
              options={SIZES}
              onChange={(headerLogoSize) => edit({ headerLogoSize })}
            />

            {/* Checkbox rather than Toggle: these are saved with the rest of
                the form by 儲存頁首, and a switch says the change already
                happened. */}
            <Checkbox
              label="捲動時固定在頂端"
              checked={settings.headerSticky}
              onChange={(headerSticky) => edit({ headerSticky })}
            />
            <Checkbox
              label="顯示購物車"
              checked={settings.headerShowCart}
              onChange={(headerShowCart) => edit({ headerShowCart })}
            />
            <Checkbox
              label="顯示登入入口"
              checked={settings.headerShowLogin}
              onChange={(headerShowLogin) => edit({ headerShowLogin })}
            />

            <TextField
              label="行動呼籲按鈕文字"
              value={settings.headerCtaLabel}
              maxLength={20}
              placeholder="留空就不顯示"
              onInput={(event) => edit({ headerCtaLabel: (event.currentTarget as HTMLInputElement).value })}
            />
            <TextField
              label="按鈕連結"
              type="url"
              value={settings.headerCtaUrl}
              placeholder="https://"
              onInput={(event) => edit({ headerCtaUrl: (event.currentTarget as HTMLInputElement).value })}
            />
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
            <RadioGroup
              legend="底色"
              inline
              value={settings.footerColour}
              options={[
                ...COLOURS,
                { value: 'custom', label: '自訂', colour: settings.footerCustomColour },
              ]}
              onChange={(footerColour) => edit({ footerColour })}
            />
            {settings.footerColour === 'custom' && (
              <ColourPicker
                label="自訂底色"
                value={settings.footerCustomColour}
                onChange={(footerCustomColour) => edit({ footerCustomColour })}
              />
            )}
            <RadioGroup
              legend="文字色"
              inline
              value={settings.footerText}
              options={[
                { value: 'dark', label: '深', colour: '#2b2622' },
                { value: 'light', label: '淺', colour: '#f3efe9' },
                { value: 'custom', label: '自訂', colour: settings.footerCustomText },
              ]}
              onChange={(footerText) => edit({ footerText })}
            />
            {settings.footerText === 'custom' && (
              <ColourPicker
                label="自訂文字色"
                value={settings.footerCustomText}
                onChange={(footerCustomText) => edit({ footerCustomText })}
              />
            )}
            <Section title="品牌欄">
              <TextField
                label="一句話介紹"
                value={settings.footerBlurb}
                maxLength={200}
                placeholder="台中的插畫工作室，把日常畫成可以帶走的東西。"
                onInput={(event) => edit({ footerBlurb: (event.currentTarget as HTMLInputElement).value })}
              />
              <TextField
                label="版權文字"
                value={settings.footerCopyright}
                maxLength={200}
                placeholder="© 2026 苒光繪誌"
                onInput={(event) => edit({ footerCopyright: (event.currentTarget as HTMLInputElement).value })}
              />
            </Section>

            <Section
              title="連結欄位"
              actions={
                <Button
                  size="sm"
                  disabled={settings.footerColumns.length >= FOOTER_COLUMN_MAX}
                  onClick={() => edit({ footerColumns: [...settings.footerColumns, { title: '', links: [] }] })}
                >
                  加一欄
                </Button>
              }
            >
            <ul class="footer-columns-editor">
              {settings.footerColumns.map((column, columnIndex) => (
                <li key={columnIndex}>
                  <div class="column-head">
                    <TextField
                      label="欄位標題"
                      hiddenLabel
                      placeholder="欄位標題"
                      maxLength={40}
                      value={column.title}
                      onInput={(event) => editColumn(columnIndex, { title: (event.currentTarget as HTMLInputElement).value })}
                    />
                    <Menu label={`第 ${columnIndex + 1} 欄的操作`}>
                      <MenuAction
                        onClick={() =>
                          editColumn(columnIndex, {
                            links: [...column.links, { label: '', url: '', newTab: true }],
                          })
                        }
                        disabled={column.links.length >= FOOTER_LINK_MAX}
                      >
                        加一個連結
                      </MenuAction>
                      <MenuAction
                        tone="danger"
                        onClick={() => edit({ footerColumns: settings.footerColumns.filter((_, at) => at !== columnIndex) })}
                      >
                        刪除這一欄
                      </MenuAction>
                    </Menu>
                  </div>
                  <ul class="link-list">
                    {column.links.map((link, linkIndex) => (
                      <li key={linkIndex}>
                        <TextField
                          label="連結文字"
                          hiddenLabel
                          placeholder="文字"
                          maxLength={40}
                          value={link.label}
                          onInput={(event) =>
                            editLink(columnIndex, linkIndex, { label: (event.currentTarget as HTMLInputElement).value })
                          }
                        />
                        <TextField
                          label="連結網址"
                          hiddenLabel
                          type="url"
                          placeholder="https://"
                          value={link.url}
                          onInput={(event) =>
                            editLink(columnIndex, linkIndex, { url: (event.currentTarget as HTMLInputElement).value })
                          }
                        />
                        <Checkbox
                          label="另開分頁"
                          checked={link.newTab}
                          onChange={(newTab) => editLink(columnIndex, linkIndex, { newTab })}
                        />
                        <Menu label={`「${link.label || '未命名連結'}」的操作`}>
                          <MenuAction
                            tone="danger"
                            onClick={() => editColumn(columnIndex, { links: column.links.filter((_, at) => at !== linkIndex) })}
                          >
                            移除連結
                          </MenuAction>
                        </Menu>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            </Section>

            <Section
              title="社群連結"
              actions={
                <Button
                  size="sm"
                  disabled={settings.footerSocials.length >= 10}
                  onClick={() =>
                    edit({
                      footerSocials: [
                        ...settings.footerSocials,
                        { platform: 'instagram', url: '', newTab: true },
                      ],
                    })
                  }
                >
                  新增社群連結
                </Button>
              }
            >
            <ul class="link-list">
              {settings.footerSocials.map((social, index) => (
                <li key={index}>
                  <Select
                    label="平台"
                    hiddenLabel
                    value={social.platform}
                    options={socialPlatforms.map((platform) => ({ value: platform.value, label: platform.label }))}
                    onChange={(platform) => editSocial(index, { platform })}
                  />
                  <TextField
                    label="社群網址"
                    hiddenLabel
                    type="url"
                    placeholder="https://"
                    value={social.url}
                    onInput={(event) => editSocial(index, { url: (event.currentTarget as HTMLInputElement).value })}
                  />
                  <Checkbox
                    label="另開分頁"
                    checked={social.newTab}
                    onChange={(newTab) => editSocial(index, { newTab })}
                  />
                  <Menu label={`${social.platform} 連結的操作`}>
                    <MenuAction
                      tone="danger"
                      onClick={() => edit({ footerSocials: settings.footerSocials.filter((_, at) => at !== index) })}
                    >
                      移除連結
                    </MenuAction>
                  </Menu>
                </li>
              ))}
            </ul>
            </Section>
          </form>
        </Panel>
      </section>
    </AdminShell>
  )
}
