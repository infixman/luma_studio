// @vitest-environment happy-dom

/**
 * The business-card page.
 *
 * The last page still building its own everything: six `<div class="card">`
 * siblings instead of Panel, raw `<input>`/`<textarea>`/`<select>` instead of
 * the field set, a hand-rolled 顯示中/已隱藏 pill instead of Toggle, and an
 * add form permanently parked above each list. It was the clearest case of a
 * page that grew its own vocabulary in parallel with the shared one.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { BioLinkState } from '../../../shared/types'

const STATE: BioLinkState = {
  displayName: '苒光繪誌',
  bio: '台中的插畫工作室',
  avatarPath: null,
  calendarUrl: '',
  calendarTitle: '近期課程',
  calendarCount: 3,
  calendarEnabled: false,
  theme: 'warm',
  buttonShape: 'rounded',
  fontStyle: 'sans',
  items: [
    { id: 'i1', kind: 'link', title: '作品集', url: 'https://work.test', platform: null, enabled: true },
    { id: 'i2', kind: 'social', title: '', url: 'https://ig.test', platform: 'instagram', enabled: true },
  ],
}

vi.mock('../../../shared/api', () => ({
  api: vi.fn(async () => STATE),
  apiJson: vi.fn(async () => STATE),
  apiUrl: (path: string) => path,
  bioLinkPageUrl: () => 'https://luma-studio.tw/card',
  uploadBioLinkAvatar: vi.fn(async () => STATE),
}))

vi.mock('../../components/BioLinkStats', () => ({ BioLinkStatsPanel: () => <div data-stats /> }))

vi.mock('../../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { BioLinkAdminPage } from './BioLinkAdminPage'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function settle() {
  for (let i = 0; i < 40; i++) {
    if (container.querySelector('.ui-panel')) return
    await tick()
  }
}

function panel(title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('.ui-panel')].find(
    (p) => p.querySelector('.ui-panel-title')?.textContent === title,
  )
}

test('every block is a panel, not a card this page invented', async () => {
  render(<BioLinkAdminPage />, container)
  await settle()

  expect(container.querySelector('.bio-admin .card')).toBeNull()
  expect(container.querySelectorAll('.ui-panel').length).toBeGreaterThanOrEqual(5)
})

test('the fields are the shared ones', async () => {
  render(<BioLinkAdminPage />, container)
  await settle()

  expect(container.querySelector('.ui-panel-body select')).toBeNull()
  expect(container.querySelector('.ui-panel-body button.danger')).toBeNull()
  expect(container.querySelector('.ui-panel-body button.ghost')).toBeNull()
  expect(container.querySelector('.bio-toggle')).toBeNull()
})

test('adding a link is offered at the top of its own section', async () => {
  /** It used to be a form parked permanently above each list, so the two
   *  lists each carried a second form nobody was using most of the time. */
  render(<BioLinkAdminPage />, container)
  await settle()

  const links = [...container.querySelectorAll<HTMLElement>('.ui-section')].find(
    (s) => s.querySelector('.ui-subhead')?.textContent === '連結按鈕',
  )
  expect(links?.querySelector('.ui-section-actions button')?.textContent).toContain('新增')

  links!.querySelector<HTMLButtonElement>('.ui-section-actions button')!.click()
  await tick()

  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
})

test('a row hides and deletes from its own menu', async () => {
  render(<BioLinkAdminPage />, container)
  await settle()

  const row = container.querySelector<HTMLElement>('.bio-item')!
  expect(row.textContent).not.toContain('刪除')

  row.querySelector<HTMLButtonElement>('.ui-menu-wrap > button')!.click()
  await tick()

  const items = [...container.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())
  expect(items).toContain('刪除')
  expect(items?.some((label) => label?.includes('隱藏'))).toBe(true)
})

test('the public address is stated once, not as a heading plus a caption', async () => {
  /** 名片頁 was an h2 inside the first card, directly under a title bar
   *  already reading 名片 — the same duplication six other pages had fixed. */
  render(<BioLinkAdminPage />, container)
  await settle()

  expect(panel('名片頁')).toBeUndefined()
})
