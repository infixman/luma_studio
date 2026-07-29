import type { ComponentChildren } from 'preact'
import { useState, useEffect } from 'preact/hooks'

import { AdminSidebar, labelOf } from './AdminNav'
import { ThemeToggle } from './ThemeToggle'
import { StatusBar, type StatusKind } from './StatusBar'
import { api } from '../../shared/api'
import { signedInEmail } from '../lib/session'
import { routeForPath } from '../routes'

/**
 * The frame every back-office page sits in: the area rail, the page list, a
 * title bar that stays put, and the status line.
 *
 * It exists because it used to be copied into each page. Two pages agreed by
 * accident, the next two were written from scratch and came out different —
 * no header, tabs outside the container, content not in a card. A shared
 * frame is the only way that stops happening again.
 *
 * The title bar does not scroll away. These pages are long forms, and the
 * button that saves one should not have to be scrolled to; nor should the
 * page's own name disappear while somebody is halfway down it.
 */
export function AdminShell({
  current = routeForPath(location.pathname)?.path ?? '/',
  title,
  actions,
  back,
  message,
  onError,
  confirmLeave,
  children,
}: {
  /** Which page is the current one. Must match an href in AdminNav. */
  current?: string
  /** Overrides the name from the navigation — for a page about one record. */
  title?: string
  /** The page's own buttons, in the title bar. */
  actions?: ComponentChildren
  /** List page this detail view returns to. Rendered directly below the title bar. */
  back?: { href: string; label: string }
  message: { text: string; kind: StatusKind } | null
  onError: (error: unknown) => void
  /**
   * Return false to abandon signing out — for a page holding unsaved work.
   *
   * It may answer with a promise, so the page can ask through a dialog rather
   * than the browser's own `confirm()`. Signing out is one click; waiting for
   * an answer costs nothing.
   */
  confirmLeave?: () => boolean | Promise<boolean>
  children: ComponentChildren
}) {
  async function logout() {
    if (confirmLeave && !(await confirmLeave())) return
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch (error) {
      onError(error)
      return
    }
    location.assign('/')
  }

  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [menuOpen])

  return (
    <div class={`admin-layout${menuOpen ? ' menu-open' : ''}`}>
      {menuOpen && <div class="sidebar-scrim" onClick={() => setMenuOpen(false)} />}
      <AdminSidebar current={current}>
        <ThemeToggle />
        <div class="sidebar-account">
          <span class="account-email" title={signedInEmail()}>
            {signedInEmail() || '已登入'}
          </span>
          <button type="button" class="account-logout" onClick={logout} aria-label="登出" title="登出">
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 20H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h8" />
              <path d="M17 15l3-3-3-3M20 12H10" />
            </svg>
          </button>
        </div>
      </AdminSidebar>

      <main class="admin-main">
        <header class="admin-topbar">
          <button
            type="button"
            class="topbar-burger"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? '關閉選單' : '開啟選單'}
            aria-expanded={menuOpen}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
              {menuOpen
                ? <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>
                : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}
            </svg>
          </button>
          <h1 class="admin-title">{title ?? labelOf(current)}</h1>
          {actions && <div class="admin-topbar-actions">{actions}</div>}
        </header>
        {back && (
          <nav class="admin-backbar" aria-label="返回清單">
            <a class="admin-back-link" href={back.href}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              {back.label}
            </a>
          </nav>
        )}
        <StatusBar message={message} />
        <div class="admin-content">{children}</div>
      </main>
    </div>
  )
}
