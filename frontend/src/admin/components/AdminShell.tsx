import type { ComponentChildren } from 'preact'

import { AdminNav } from './AdminNav'
import { StatusBar, type StatusKind } from './StatusBar'
import { api, clearLoginAttempt } from '../../shared/api'

/**
 * The frame every back-office page sits in: the mark, the way out, the tabs,
 * and the status line.
 *
 * It exists because it used to be copied into each page. Two pages agreed by
 * accident, the next two were written from scratch and came out different —
 * no header, tabs outside the container, content not in a card. A shared
 * frame is the only way that stops happening again.
 */
export function AdminShell({
  current,
  message,
  onError,
  confirmLeave,
  children,
}: {
  /** Which tab is the current one. Must match an href in AdminNav. */
  current: string
  message: { text: string; kind: StatusKind } | null
  onError: (error: unknown) => void
  /** Return false to abandon signing out — for a page holding unsaved work. */
  confirmLeave?: () => boolean
  children: ComponentChildren
}) {
  async function logout() {
    if (confirmLeave && !confirmLeave()) return
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch (error) {
      onError(error)
      return
    }
    clearLoginAttempt()
    location.assign('/')
  }

  return (
    <main>
      <header>
        <img class="brand-logo" src="/assets/luma-studio-logo.png" alt="Luma Studio 苒光繪誌" />
        <button class="ghost" onClick={logout}>
          登出
        </button>
      </header>
      <AdminNav current={current} />
      <StatusBar message={message} />
      {children}
    </main>
  )
}
