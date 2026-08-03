import { useEffect, useRef, useState } from 'preact/hooks'

import { BioLinkAppearance } from '../../components/BioLinkAppearance'
import { BioLinkStatsPanel } from '../../components/BioLinkStats'
import { CopyButton, OpenButton } from '../../components/IconButtons'
import { SocialIcon, platformLabel, socialPlatforms } from '../../../shared/components/SocialIcon'
import { AdminShell } from '../../components/AdminShell'
import { useStatus } from '../../components/StatusBar'
import {
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Menu,
  MenuItem as MenuAction,
  Modal,
  Panel,
  Section,
  Select,
  Spinner,
  TextArea,
  TextField,
  useConfirm,
} from '../../components/ui'
import { api, apiJson, apiUrl, bioLinkPageUrl, uploadBioLinkAvatar } from '../../../shared/api'
import type { BioLinkItem, BioLinkKind, BioLinkState } from '../../../shared/types'
import '../../styles/bio-link-admin.css'

// Mirrors the bio-link domain contract; backend validation remains authoritative.
const MAX_DISPLAY_NAME = 64
const MAX_BIO = 300
const MAX_TITLE = 80
const MAX_URL = 2048
const MAX_ITEMS = 50
const MAX_AVATAR_MB = 2
const MAX_CALENDAR_TITLE = 40
const MAX_CALENDAR_COUNT = 12
const AVATAR_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp']
const AVATAR_ACCEPT = AVATAR_EXTENSIONS.map((extension) => `.${extension}`).join(',')
const AVATAR_PATTERN = new RegExp(`\\.(${AVATAR_EXTENSIONS.join('|')})$`, 'i')

/**
 * A link the editor is holding but the server has never seen.
 *
 * The colon cannot appear in a real id, so if one of these ever reaches the
 * API it is rejected rather than silently creating or overwriting a row.
 */
const NEW_ITEM_PREFIX = 'new:'
let newItemCounter = 0

interface Draft {
  title: string
  url: string
  platform: string
}

const emptyDraft: Draft = { title: '', url: '', platform: 'instagram' }

/** Named because each dialog's submit button sits in its own footer. */
const ADD_FORM = 'new-bio-item'

export function BioLinkAdminPage() {
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()
  // `saved` is the server's copy, `page` is what the editor is holding. The
  // difference between them is what the save button writes.
  const [saved, setSaved] = useState<BioLinkState | null>(null)
  const [page, setPage] = useState<BioLinkState | null>(null)
  const [linkDraft, setLinkDraft] = useState<Draft>({ ...emptyDraft })
  const [socialDraft, setSocialDraft] = useState<Draft>({ ...emptyDraft })
  const [busy, setBusy] = useState(false)
  /** Which list is being added to, if either. */
  const [adding, setAdding] = useState<BioLinkKind | null>(null)
  const avatarInput = useRef<HTMLInputElement>(null)

  const adopt = (data: BioLinkState) => {
    setSaved(data)
    setPage(data)
  }

  useEffect(() => {
    let cancelled = false
    api<BioLinkState>('/api/bio-link')
      .then((data) => {
        if (!cancelled) adopt(data)
      })
      .catch((error: unknown) => {
        // A 401 has already redirected to Google inside the API wrapper.
        if (!cancelled) showError(error)
      })
    return () => {
      cancelled = true
    }
  }, [showError])

  const dirty = page !== null && saved !== null && JSON.stringify(page) !== JSON.stringify(saved)

  // Closing the tab is the one exit this component cannot intercept, so it
  // is the one that needs the browser's own warning.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [dirty])

  /**
   * Every mutation returns the whole page state, so the UI adopts the
   * server's version instead of guessing. No optimistic update means no
   * rollback and no way for a failed write to leave stale values on screen.
   */
  const mutate = async (run: () => Promise<BioLinkState>, successMessage?: string) => {
    setBusy(true)
    try {
      adopt(await run())
      if (successMessage) show(successMessage, 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** Edits the editor's copy only. Nothing here reaches the server. */
  const edit = (patch: Partial<BioLinkState>) => setPage((current) => (current ? { ...current, ...patch } : current))

  const savePage = async () => {
    if (!page || !saved) return
    const removed = saved.items.filter((item) => !page.items.some((kept) => kept.id === item.id))
    if (removed.length) {
      // Naming them: "3 筆連結" is not enough to notice you dragged the wrong
      // row out, and the click history goes with them.
      const agreed = await ask({
        title: '儲存後這些連結會不見',
        body: (
          <>
            <p>連同它們的點擊統計一起刪除，無法復原。</p>
            <ul class="usage">
              {removed.map((item) => (
                <li key={item.id}>{item.title || item.url || '(未命名)'}</li>
              ))}
            </ul>
          </>
        ),
        confirmLabel: '儲存',
      })
      if (!agreed) return
    }

    void mutate(
      () =>
        apiJson<BioLinkState>('/api/bio-link', 'PUT', {
          displayName: page.displayName,
          bio: page.bio,
          theme: page.theme,
          buttonShape: page.buttonShape,
          fontStyle: page.fontStyle,
          calendarUrl: page.calendarUrl,
          calendarTitle: page.calendarTitle,
          calendarCount: page.calendarCount,
          calendarEnabled: page.calendarEnabled,
          items: page.items.map((item) => ({
            // A link the server has never stored is sent without an id, so
            // it inserts rather than trying to find a row that is not there.
            id: item.id.startsWith(NEW_ITEM_PREFIX) ? null : item.id,
            kind: item.kind,
            title: item.title,
            url: item.url,
            platform: item.platform,
            enabled: item.enabled,
          })),
        }),
      '已儲存，公開頁已更新。',
    )
  }

  const revert = async () => {
    if (!saved || !dirty) return
    const agreed = await ask({
      title: '放棄未儲存的修改？',
      body: '頁面會回到上次儲存的樣子。',
      confirmLabel: '放棄',
    })
    if (!agreed) return
    setPage(saved)
    show('已還原成上次儲存的內容。', 'ok')
  }

  const testCalendar = () => {
    if (!page) return
    setBusy(true)
    apiJson<{ count: number }>('/api/bio-link/calendar/test', 'POST', { calendarUrl: page.calendarUrl })
      .then((result) => show(`讀到 ${result.count} 場活動。`, 'ok'))
      .catch(showError)
      .finally(() => setBusy(false))
  }

  /**
   * The avatar is uploaded straight away rather than held in the draft: it is
   * a file, not a field, and keeping one in memory until a later save is a
   * different kind of promise than the rest of this form makes.
   */
  const changeAvatar = async (file: File | undefined) => {
    if (!file) return
    if (avatarInput.current) avatarInput.current.value = ''
    if (!AVATAR_PATTERN.test(file.name)) {
      show(`頭像只可上傳 ${AVATAR_EXTENSIONS.join('、')}。`, 'error')
      return
    }
    if (file.size > MAX_AVATAR_MB * 1024 * 1024) {
      show(`頭像不可超過 ${MAX_AVATAR_MB} MB。`, 'error')
      return
    }
    if (dirty) {
      const agreed = await ask({
        title: '上傳頭像會先儲存目前的修改',
        body: '目前未儲存的內容會一起送出。',
        confirmLabel: '繼續',
        tone: 'primary',
      })
      if (!agreed) return
    }
    await mutate(() => uploadBioLinkAvatar(file), '頭像已更新。')
  }

  const removeAvatar = async () => {
    const agreed = await ask({ title: '移除頭像？', body: '公開頁會改用 logo。', confirmLabel: '移除' })
    if (!agreed) return
    void mutate(() => api<BioLinkState>('/api/bio-link/avatar', { method: 'DELETE' }), '頭像已移除。')
  }

  const addItem = (kind: BioLinkKind) => {
    if (!page) return
    const draft = kind === 'link' ? linkDraft : socialDraft
    const title = kind === 'social' ? draft.title.trim() || platformLabel(draft.platform) : draft.title.trim()
    if (!title || !draft.url.trim()) {
      show('請填寫標題與網址。', 'error')
      return
    }
    if (page.items.length >= MAX_ITEMS) {
      show(`已達上限（${MAX_ITEMS} 筆）。請先刪除不用的連結。`, 'error')
      return
    }

    newItemCounter += 1
    const item: BioLinkItem = {
      id: `${NEW_ITEM_PREFIX}${newItemCounter}`,
      kind,
      title,
      url: draft.url.trim(),
      platform: kind === 'social' ? draft.platform : null,
      enabled: true,
    }
    edit({ items: [...page.items, item] })
    if (kind === 'link') setLinkDraft({ ...emptyDraft })
    else setSocialDraft({ ...emptyDraft, platform: draft.platform })
    setAdding(null)
  }

  const editItem = (id: string, changes: Partial<BioLinkItem>) => {
    setPage((current) =>
      current ? { ...current, items: current.items.map((item) => (item.id === id ? { ...item, ...changes } : item)) } : current,
    )
  }

  const removeItem = (item: BioLinkItem) => {
    if (!page) return
    edit({ items: page.items.filter((other) => other.id !== item.id) })
  }

  /** Moves within one kind; the other kind's order is left untouched. */
  const reorderTo = (kind: BioLinkKind, from: number, to: number) => {
    if (!page) return
    const group = page.items.filter((item) => item.kind === kind)
    if (from === to || to < 0 || to >= group.length) return
    const reordered = [...group]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved!)
    const others = page.items.filter((item) => item.kind !== kind)
    edit({ items: kind === 'social' ? [...reordered, ...others] : [...others, ...reordered] })
  }

  const moveItem = (kind: BioLinkKind, index: number, delta: number) => reorderTo(kind, index, index + delta)

  /**
   * Dragging is the faster gesture, but the arrow buttons stay: dragging is
   * unusable with a keyboard and awkward on a phone.
   */
  const dragged = useRef<{ kind: BioLinkKind; index: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const onDrop = (kind: BioLinkKind, index: number) => {
    const source = dragged.current
    dragged.current = null
    setDropTarget(null)
    if (source && source.kind === kind) reorderTo(kind, source.index, index)
  }


  const atCapacity = (page?.items.length ?? 0) >= MAX_ITEMS

  const renderGroup = (kind: BioLinkKind) => {
    const group = page?.items.filter((item) => item.kind === kind) ?? []
    const draft = kind === 'link' ? linkDraft : socialDraft
    const setDraft = kind === 'link' ? setLinkDraft : setSocialDraft

    void draft
    void setDraft

    return (
      <Section
        title={kind === 'link' ? '連結按鈕' : '社群 icon'}
        actions={
          <Button size="sm" disabled={busy || atCapacity} onClick={() => setAdding(kind)}>
            新增
          </Button>
        }
      >
        {group.length === 0 ? (
          <EmptyState title="尚未新增。" compact />
        ) : (
          <ul class="bio-items">
            {group.map((item, index) => (
              <li
                key={item.id}
                class={[
                  'bio-item',
                  item.enabled ? '' : 'disabled',
                  dropTarget === item.id ? 'drop-target' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable
                onDragStart={() => {
                  dragged.current = { kind, index }
                }}
                onDragOver={(event) => {
                  if (dragged.current?.kind !== kind) return
                  event.preventDefault()
                  setDropTarget(item.id)
                }}
                onDragLeave={() => setDropTarget((current) => (current === item.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault()
                  onDrop(kind, index)
                }}
                onDragEnd={() => {
                  dragged.current = null
                  setDropTarget(null)
                }}
              >
                <span class="bio-item-grip" aria-hidden="true" title="拖曳排序">
                  ⠿
                </span>
                {kind === 'social' && (
                  <span class="bio-item-platform" title={platformLabel(item.platform)}>
                    <SocialIcon platform={item.platform} />
                  </span>
                )}
                <div class="bio-item-fields">
                  <TextField
                    label="標題"
                    hiddenLabel
                    maxLength={MAX_TITLE}
                    value={item.title}
                    onInput={(event) => editItem(item.id, { title: (event.currentTarget as HTMLInputElement).value })}
                  />
                  <TextField
                    label="網址"
                    hiddenLabel
                    maxLength={MAX_URL}
                    value={item.url}
                    onInput={(event) => editItem(item.id, { url: (event.currentTarget as HTMLInputElement).value })}
                  />
                </div>
                {/* The two arrows stay out: reordering is what this list is
                    for. Hiding and deleting go behind the menu, same as
                    every other row in the back office. */}
                <div class="bio-item-actions">
                  <IconButton label="上移" size="sm" disabled={busy || index === 0} onClick={() => moveItem(kind, index, -1)}>
                    <span aria-hidden="true">↑</span>
                  </IconButton>
                  <IconButton
                    label="下移"
                    size="sm"
                    disabled={busy || index === group.length - 1}
                    onClick={() => moveItem(kind, index, 1)}
                  >
                    <span aria-hidden="true">↓</span>
                  </IconButton>
                  <Menu label={`「${item.title || item.url}」的操作`}>
                    <MenuAction disabled={busy} onClick={() => editItem(item.id, { enabled: !item.enabled })}>
                      {item.enabled ? '隱藏' : '顯示'}
                    </MenuAction>
                    <MenuAction tone="danger" disabled={busy} onClick={() => removeItem(item)}>
                      刪除
                    </MenuAction>
                  </Menu>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    )
  }


  return (
    <AdminShell
      current="/card"
      message={message}
      onError={showError}
      actions={
        <>
          {dirty && <span class="unsaved-mark">有未儲存的修改</span>}
          <Button tone="ghost" disabled={!dirty} onClick={() => void revert()}>
            還原
          </Button>
          <Button tone="primary" busy={busy} disabled={!dirty} onClick={() => void savePage()}>
            儲存
          </Button>
        </>
      }
      confirmLeave={async () =>
        !dirty ||
        (await ask({
          title: '有未儲存的修改',
          body: '登出後會遺失。',
          confirmLabel: '登出',
        }))
      }
    >

      {page === null ? (
        <Spinner />
      ) : (
        <section class="bio-admin">
          {/* No title: the navigation and the title bar both already say 名片.
              What is worth saying here is the address, which the title bar
              cannot show. */}
          <Panel>
            {/* One row, not a panel header holding two buttons over a line of
                text saying what they act on. With no title to sit beside, that
                header was an empty band splitting one idea in half. */}
            <p class="muted bio-address">
              公開網址：{bioLinkPageUrl()}
              <span class="bio-address-actions">
                <OpenButton url={bioLinkPageUrl()} label="公開的名片頁" />
                <CopyButton
                  url={bioLinkPageUrl()}
                  label="公開的名片頁"
                  onCopied={(label) => show(`已複製「${label}」的網址。`, 'ok')}
                  onFailed={showError}
                />
              </span>
            </p>

            <div class="bio-avatar-field">
              {page.avatarPath ? (
                <img class="bio-avatar-preview" src={apiUrl(page.avatarPath)} alt="目前頭像" />
              ) : (
                <img class="bio-avatar-preview is-logo" src="/assets/luma-studio-logo.png" alt="尚未設定頭像，公開頁使用 logo" />
              )}
              <div>
                <input
                  ref={avatarInput}
                  type="file"
                  accept={AVATAR_ACCEPT}
                  hidden
                  onChange={(event) => changeAvatar(event.currentTarget.files?.[0])}
                />
                <div class="bio-avatar-buttons">
                  <Button size="sm" disabled={busy} onClick={() => avatarInput.current?.click()}>
                    {page.avatarPath ? '更換頭像' : '上傳頭像'}
                  </Button>
                  {page.avatarPath && (
                    <Button size="sm" tone="danger" disabled={busy} onClick={() => void removeAvatar()}>
                      移除
                    </Button>
                  )}
                </div>
                <p class="muted">
                  {AVATAR_EXTENSIONS.join('、')}，{MAX_AVATAR_MB} MB 以內。頭像會立即套用，不需按儲存。
                </p>
              </div>
            </div>

            <TextField
              label="顯示名稱"
              maxLength={MAX_DISPLAY_NAME}
              value={page.displayName}
              onInput={(event) => edit({ displayName: (event.currentTarget as HTMLInputElement).value })}
            />

            <TextArea
              label="簡介"
              maxLength={MAX_BIO}
              rows={3}
              hint={`${page.bio.length} / ${MAX_BIO}`}
              value={page.bio}
              onInput={(event) => edit({ bio: (event.currentTarget as HTMLTextAreaElement).value })}
            />
          </Panel>

          <Panel title="外觀">
            <BioLinkAppearance
              style={page}
              avatarPath={page.avatarPath ? apiUrl(page.avatarPath) : null}
              displayName={page.displayName}
              busy={busy}
              onChange={(patch) => edit(patch)}
            />
          </Panel>

          <Panel title="課程行事曆">
            <div class="bio-calendar-settings">
              <Checkbox
                label="在公開頁顯示近期活動"
                checked={page.calendarEnabled}
                disabled={busy}
                onChange={(calendarEnabled) => edit({ calendarEnabled })}
              />

              <div class="bio-calendar-row">
                <TextField
                  label="日曆網址"
                  placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
                  maxLength={MAX_URL}
                  value={page.calendarUrl}
                  hint="Google 日曆 → 設定 → 這個日曆的設定 → 公開網址 (iCal)。日曆要設為公開，分享權限選「查看所有活動詳細資訊」，否則課名會變成 Busy。"
                  onInput={(event) => edit({ calendarUrl: (event.currentTarget as HTMLInputElement).value })}
                />
                <Button size="sm" disabled={busy || !page.calendarUrl} onClick={testCalendar}>
                  測試連線
                </Button>
              </div>

              <div class="bio-calendar-row">
                <TextField
                  label="區塊標題"
                  maxLength={MAX_CALENDAR_TITLE}
                  value={page.calendarTitle}
                  onInput={(event) => edit({ calendarTitle: (event.currentTarget as HTMLInputElement).value })}
                />
                <TextField
                  label="最多顯示"
                  type="number"
                  min={1}
                  max={MAX_CALENDAR_COUNT}
                  class="bio-field-narrow"
                  value={page.calendarCount}
                  onInput={(event) => edit({ calendarCount: Number((event.currentTarget as HTMLInputElement).value) })}
                />
              </div>

              <p class="bio-calendar-warning">
                公開頁會顯示活動的標題、時間、地點與說明。日曆上的說明欄若寫了學員姓名或聯絡方式，任何人都看得到。
              </p>
            </div>
          </Panel>

          <Panel title={`連結（${page.items.length} / ${MAX_ITEMS}）`}>
            {/* Same order as the public page, so the editor previews itself. */}
            {renderGroup('social')}
            {renderGroup('link')}
          </Panel>

          <Panel title="統計">
            <BioLinkStatsPanel onError={showError} />
          </Panel>

          <Modal
            title={adding === 'social' ? '新增社群 icon' : '新增連結按鈕'}
            open={adding !== null}
            onClose={() => setAdding(null)}
            footer={
              <>
                <Button tone="ghost" onClick={() => setAdding(null)}>
                  取消
                </Button>
                <Button type="submit" form={ADD_FORM} tone="primary" disabled={busy}>
                  新增
                </Button>
              </>
            }
          >
            <form
              id={ADD_FORM}
              onSubmit={(event) => {
                event.preventDefault()
                if (adding) addItem(adding)
              }}
            >
              {adding === 'social' && (
                <Select
                  label="社群平台"
                  value={socialDraft.platform}
                  options={socialPlatforms.map((option) => ({ value: option.value, label: option.label }))}
                  onChange={(platform) => setSocialDraft({ ...socialDraft, platform })}
                />
              )}
              <TextField
                label="標題"
                placeholder={adding === 'link' ? '例如 作品集' : '留空就用平台名稱'}
                maxLength={MAX_TITLE}
                value={adding === 'social' ? socialDraft.title : linkDraft.title}
                onInput={(event) => {
                  const title = (event.currentTarget as HTMLInputElement).value
                  if (adding === 'social') setSocialDraft({ ...socialDraft, title })
                  else setLinkDraft({ ...linkDraft, title })
                }}
              />
              <TextField
                label="網址"
                placeholder="https://"
                maxLength={MAX_URL}
                required
                value={adding === 'social' ? socialDraft.url : linkDraft.url}
                onInput={(event) => {
                  const url = (event.currentTarget as HTMLInputElement).value
                  if (adding === 'social') setSocialDraft({ ...socialDraft, url })
                  else setLinkDraft({ ...linkDraft, url })
                }}
              />
            </form>
          </Modal>
        </section>
      )}
      {dialog}
    </AdminShell>
  )
}
