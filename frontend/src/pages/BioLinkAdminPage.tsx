import { useEffect, useRef, useState } from 'preact/hooks'

import { AdminNav } from '../components/AdminNav'
import { BioLinkAppearance } from '../components/BioLinkAppearance'
import { BioLinkStatsPanel } from '../components/BioLinkStats'
import { CopyButton, OpenButton } from '../components/IconButtons'
import { SocialIcon, platformLabel, socialPlatforms } from '../components/SocialIcon'
import { StatusBar, useStatus } from '../components/StatusBar'
import { ApiError, api, apiJson, apiUrl, bioLinkPageUrl, clearLoginAttempt, uploadBioLinkAvatar } from '../lib/api'
import type { BioLinkItem, BioLinkKind, BioLinkState } from '../lib/types'
import '../styles/admin.css'
import '../styles/bio-link-admin.css'

// Mirrors the limits in backend/src/bio_link.py, which is the source of truth.
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

interface Draft {
  title: string
  url: string
  platform: string
}

const emptyDraft: Draft = { title: '', url: '', platform: 'instagram' }

export function BioLinkAdminPage() {
  const { message, show, showError } = useStatus()
  const [state, setState] = useState<BioLinkState | null>(null)
  const [linkDraft, setLinkDraft] = useState<Draft>({ ...emptyDraft })
  const [socialDraft, setSocialDraft] = useState<Draft>({ ...emptyDraft })
  const [busy, setBusy] = useState(false)
  const avatarInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    api<BioLinkState>('/api/admin/bio-link')
      .then((data) => {
        if (!cancelled) setState(data)
      })
      .catch((error: unknown) => {
        // A 401 has already redirected to Google inside the API wrapper.
        if (!cancelled && !(error instanceof ApiError && error.status === 401)) showError(error)
      })
    return () => {
      cancelled = true
    }
  }, [showError])

  /**
   * Every mutation returns the whole page state, so the UI adopts the server's
   * version instead of guessing. No optimistic update means no rollback and no
   * way for a failed write to leave stale values on screen.
   */
  const mutate = async (run: () => Promise<BioLinkState>, successMessage?: string) => {
    setBusy(true)
    try {
      setState(await run())
      if (successMessage) show(successMessage, 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Sends the whole settings object every time. The server validates all of
   * it together, so a partial write would need it to merge — which is where
   * "I changed the theme and my bio reverted" comes from.
   */
  const saveSettings = (patch: Partial<BioLinkState>, message = '已儲存。') => {
    if (!state) return
    const next = { ...state, ...patch }
    setState(next)
    void mutate(
      () =>
        apiJson<BioLinkState>('/api/admin/bio-link', 'PUT', {
          displayName: next.displayName,
          bio: next.bio,
          theme: next.theme,
          buttonShape: next.buttonShape,
          fontStyle: next.fontStyle,
          calendarUrl: next.calendarUrl,
          calendarTitle: next.calendarTitle,
          calendarCount: next.calendarCount,
          calendarEnabled: next.calendarEnabled,
        }),
      message,
    )
  }

  const testCalendar = () => {
    if (!state) return
    setBusy(true)
    apiJson<{ count: number }>('/api/admin/bio-link/calendar/test', 'POST', { calendarUrl: state.calendarUrl })
      .then((result) => show(`讀到 ${result.count} 場活動。`, 'ok'))
      .catch(showError)
      .finally(() => setBusy(false))
  }

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
    await mutate(() => uploadBioLinkAvatar(file), '頭像已更新。')
  }

  const removeAvatar = () => {
    if (!confirm('移除頭像？公開頁會改用 logo。')) return
    void mutate(() => api<BioLinkState>('/api/admin/bio-link/avatar', { method: 'DELETE' }), '頭像已移除。')
  }

  const addItem = (kind: BioLinkKind) => {
    const draft = kind === 'link' ? linkDraft : socialDraft
    const title = kind === 'social' ? draft.title.trim() || platformLabel(draft.platform) : draft.title.trim()
    if (!title || !draft.url.trim()) {
      show('請填寫標題與網址。', 'error')
      return
    }
    if (state && state.items.length >= MAX_ITEMS) {
      show(`已達上限（${MAX_ITEMS} 筆）。請先刪除不用的連結。`, 'error')
      return
    }
    void mutate(async () => {
      const next = await apiJson<BioLinkState>('/api/admin/bio-link/items', 'POST', {
        kind,
        title,
        url: draft.url.trim(),
        platform: kind === 'social' ? draft.platform : null,
      })
      if (kind === 'link') setLinkDraft({ ...emptyDraft })
      else setSocialDraft({ ...emptyDraft, platform: draft.platform })
      return next
    }, '已新增。')
  }

  /** Local echo while typing; the server's copy lands on blur. */
  const editItem = (id: string, changes: Partial<BioLinkItem>) => {
    setState((current) =>
      current ? { ...current, items: current.items.map((item) => (item.id === id ? { ...item, ...changes } : item)) } : current,
    )
  }

  const saveItem = (item: BioLinkItem, changes: Partial<BioLinkItem> = {}) => {
    const next = { ...item, ...changes }
    void mutate(
      () =>
        apiJson<BioLinkState>(`/api/admin/bio-link/items/${encodeURIComponent(item.id)}`, 'PUT', {
          title: next.title,
          url: next.url,
          enabled: next.enabled,
        }),
      '已儲存。',
    )
  }

  const removeItem = (item: BioLinkItem) => {
    if (!confirm(`刪除「${item.title}」？`)) return
    void mutate(
      () => api<BioLinkState>(`/api/admin/bio-link/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' }),
      '已刪除。',
    )
  }

  /** Moves within one kind, then sends every id so nothing half-applies. */
  const reorderTo = (kind: BioLinkKind, from: number, to: number) => {
    if (!state) return
    const group = state.items.filter((item) => item.kind === kind)
    if (from === to || to < 0 || to >= group.length) return
    const reordered = [...group]
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved!)
    const others = state.items.filter((item) => item.kind !== kind)
    void mutate(
      () =>
        apiJson<BioLinkState>('/api/admin/bio-link/items/order', 'PUT', {
          ids: [...reordered, ...others].map((item) => item.id),
        }),
      '順序已更新。',
    )
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

  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch (error) {
      showError(error)
      return
    }
    clearLoginAttempt()
    location.assign('/')
  }

  const atCapacity = (state?.items.length ?? 0) >= MAX_ITEMS

  const renderGroup = (kind: BioLinkKind) => {
    const group = state?.items.filter((item) => item.kind === kind) ?? []
    const draft = kind === 'link' ? linkDraft : socialDraft
    const setDraft = kind === 'link' ? setLinkDraft : setSocialDraft

    return (
      <section class="bio-group">
        <h3>{kind === 'link' ? '連結按鈕' : '社群 icon'}</h3>
        <div class="bio-draft">
          {kind === 'social' && (
            <select
              aria-label="社群平台"
              value={draft.platform}
              onChange={(event) => setDraft({ ...draft, platform: event.currentTarget.value })}
            >
              {socialPlatforms.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <input
            placeholder={kind === 'link' ? '標題，例如 作品集' : '標題（留空用平台名稱）'}
            maxLength={MAX_TITLE}
            value={draft.title}
            onInput={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
          />
          <input
            placeholder="https://"
            maxLength={MAX_URL}
            value={draft.url}
            onInput={(event) => setDraft({ ...draft, url: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addItem(kind)
            }}
          />
          <button disabled={busy || atCapacity} onClick={() => addItem(kind)}>
            新增
          </button>
        </div>

        {group.length === 0 ? (
          <p class="muted">尚未新增。</p>
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
                  <input
                    aria-label="標題"
                    maxLength={MAX_TITLE}
                    value={item.title}
                    onInput={(event) => editItem(item.id, { title: event.currentTarget.value })}
                    onChange={() => saveItem(item)}
                  />
                  <input
                    aria-label="網址"
                    maxLength={MAX_URL}
                    value={item.url}
                    onInput={(event) => editItem(item.id, { url: event.currentTarget.value })}
                    onChange={() => saveItem(item)}
                  />
                </div>
                <div class="bio-item-actions">
                  <button class="ghost" title="上移" aria-label="上移" disabled={busy || index === 0} onClick={() => moveItem(kind, index, -1)}>
                    ↑
                  </button>
                  <button
                    class="ghost"
                    title="下移"
                    aria-label="下移"
                    disabled={busy || index === group.length - 1}
                    onClick={() => moveItem(kind, index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    class={item.enabled ? 'bio-toggle on' : 'bio-toggle off'}
                    disabled={busy}
                    aria-pressed={item.enabled}
                    title={item.enabled ? '目前顯示中，點擊隱藏' : '目前已隱藏，點擊顯示'}
                    onClick={() => saveItem(item, { enabled: !item.enabled })}
                  >
                    {item.enabled ? '顯示中' : '已隱藏'}
                  </button>
                  <button class="danger" disabled={busy} onClick={() => removeItem(item)}>
                    刪除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  const remaining = state ? MAX_ITEMS - state.items.length : MAX_ITEMS

  return (
    <main>
      <header>
        <img class="brand-logo" src="/assets/luma-studio-logo.png" alt="Luma Studio 苒光繪誌" />
        <button class="ghost" onClick={logout}>
          登出
        </button>
      </header>
      <AdminNav current="/admin/bio-link" />
      <StatusBar message={message} />

      {state === null ? (
        <p class="muted bio-loading">載入中…</p>
      ) : (
        <section class="bio-admin">
          <div class="card">
            <div class="bio-admin-head">
              <div>
                <h2>Bio Link</h2>
                <p class="muted">公開網址：{bioLinkPageUrl()}</p>
              </div>
              <div class="bio-admin-head-actions">
                <OpenButton url={bioLinkPageUrl()} label="公開的 Bio Link 頁" />
                <CopyButton
                  url={bioLinkPageUrl()}
                  label="公開的 Bio Link 頁"
                  onCopied={(label) => show(`已複製「${label}」的網址。`, 'ok')}
                  onFailed={showError}
                />
              </div>
            </div>

            <div class="bio-avatar-field">
              {state.avatarPath ? (
                <img class="bio-avatar-preview" src={apiUrl(state.avatarPath)} alt="目前頭像" />
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
                  <button class="ghost" disabled={busy} onClick={() => avatarInput.current?.click()}>
                    {state.avatarPath ? '更換頭像' : '上傳頭像'}
                  </button>
                  {state.avatarPath && (
                    <button class="ghost" disabled={busy} onClick={removeAvatar}>
                      移除
                    </button>
                  )}
                </div>
                <p class="muted">
                  {AVATAR_EXTENSIONS.join('、')}，{MAX_AVATAR_MB} MB 以內。未設定時公開頁顯示 logo。
                </p>
              </div>
            </div>

            <label class="bio-field">
              <span>顯示名稱</span>
              <input
                maxLength={MAX_DISPLAY_NAME}
                value={state.displayName}
                onInput={(event) => setState({ ...state, displayName: event.currentTarget.value })}
                onChange={(event) => saveSettings({ displayName: event.currentTarget.value })}
              />
            </label>

            <label class="bio-field">
              <span>簡介</span>
              <textarea
                maxLength={MAX_BIO}
                rows={3}
                value={state.bio}
                onInput={(event) => setState({ ...state, bio: event.currentTarget.value })}
                onChange={(event) => saveSettings({ bio: event.currentTarget.value })}
              />
              <span class="muted">
                {state.bio.length} / {MAX_BIO}
              </span>
            </label>
          </div>

          <div class="card">
            <h2>外觀</h2>
            <BioLinkAppearance
              style={state}
              avatarPath={state.avatarPath ? apiUrl(state.avatarPath) : null}
              displayName={state.displayName}
              busy={busy}
              onChange={(patch) => saveSettings(patch)}
            />
          </div>

          <div class="card">
            <h2>課程行事曆</h2>
            <p class="muted">
              在 Google 日曆的「設定 → 這個日曆的設定 → 公開網址 (iCal 格式)」複製網址貼上。日曆必須設為公開。
            </p>
            <div class="bio-calendar-settings">
              <label class="bio-checkbox">
                <input
                  type="checkbox"
                  checked={state.calendarEnabled}
                  disabled={busy}
                  onChange={(event) => saveSettings({ calendarEnabled: event.currentTarget.checked })}
                />
                <span>在公開頁顯示近期活動</span>
              </label>

              <div class="bio-calendar-row">
                <input
                  type="text"
                  placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
                  maxLength={MAX_URL}
                  value={state.calendarUrl}
                  onInput={(event) => setState({ ...state, calendarUrl: event.currentTarget.value })}
                  onChange={(event) => saveSettings({ calendarUrl: event.currentTarget.value })}
                />
                <button type="button" class="ghost" disabled={busy || !state.calendarUrl} onClick={testCalendar}>
                  測試連線
                </button>
              </div>

              <div class="bio-calendar-row">
                <label class="bio-field">
                  <span>區塊標題</span>
                  <input
                    type="text"
                    maxLength={MAX_CALENDAR_TITLE}
                    value={state.calendarTitle}
                    onInput={(event) => setState({ ...state, calendarTitle: event.currentTarget.value })}
                    onChange={(event) => saveSettings({ calendarTitle: event.currentTarget.value })}
                  />
                </label>
                <label class="bio-field bio-field-narrow">
                  <span>最多顯示</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_CALENDAR_COUNT}
                    value={state.calendarCount}
                    onChange={(event) => saveSettings({ calendarCount: Number(event.currentTarget.value) })}
                  />
                </label>
              </div>

              <p class="bio-calendar-warning">
                公開頁會顯示活動的標題、時間、地點與說明。日曆上的說明欄若寫了學員姓名或聯絡方式，任何人都看得到。
              </p>
            </div>
          </div>

          <div class="card">
            <p class="muted bio-quota">
              目前 {state.items.length} / {MAX_ITEMS} 筆，還可新增 {Math.max(0, remaining)} 筆。
            </p>
            {/* Same order as the public page, so the editor previews itself. */}
            {renderGroup('social')}
            {renderGroup('link')}
          </div>

          <div class="card">
            <BioLinkStatsPanel onError={showError} />
          </div>
        </section>
      )}
    </main>
  )
}
