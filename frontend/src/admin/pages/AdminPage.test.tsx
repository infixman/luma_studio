// @vitest-environment happy-dom

/**
 * The ibon print-folder tool.
 *
 * This page was the one part of the back office still hand-built out of raw
 * `<div class="card">` and bare `<button>` — its own create-folder input sat
 * permanently above the folder list, and the same three actions (open, copy,
 * delete) were three separate visible controls on every row instead of the
 * one overflow menu the rest of the admin already settled on. This file
 * pins the shape it was rebuilt into: creating is a dialog reached from the
 * folders panel's own header, and every row action — folder or file — lives
 * behind one menu at the end of the row.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { FolderListing, ObjectListing, PrintSettingsResponse, StoredObject } from '../../shared/types'

let folders: string[] = []
let objects: StoredObject[] = []
const posted: { url: string; body: unknown }[] = []

vi.mock('../../shared/api', () => ({
  api: vi.fn(async (url: string) => {
    if (url === '/api/session') return { email: 'owner@example.com' }
    if (url.startsWith('/api/folders')) return { folders, truncated: false } satisfies FolderListing
    if (url.startsWith('/api/objects')) return { folder: '', objects, truncated: false } satisfies ObjectListing
    if (url.startsWith('/api/print-settings')) {
      return { folder: '', selectType: 'FA4CN1', printSpec: 'A4 彩色 單面 一般用紙' } satisfies PrintSettingsResponse
    }
    return {}
  }),
  apiJson: vi.fn(async (url: string, _method: string, body: unknown) => {
    posted.push({ url, body })
    if (url === '/api/folders') return {}
    if (url === '/api/print-settings') return { folder: '', selectType: 'FA4CN1', printSpec: 'A4 彩色 單面 一般用紙' }
    return {}
  }),
  ApiError: class ApiError extends Error {},
  printPageUrl: (name: string) => `https://print.example/${name}`,
  publicImageUrl: (key: string) => `https://public.example/${key}`,
  thumbnailUrl: (key: string) => `https://public.example/${key}?thumb`,
  uploadImage: vi.fn(async () => {}),
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com', rememberSignedIn: () => {} }))

import { AdminPage } from './AdminPage'

let container: HTMLDivElement

beforeEach(() => {
  folders = []
  objects = []
  posted.length = 0
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
  vi.restoreAllMocks()
})

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function settle() {
  for (let i = 0; i < 30; i++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await tick()
  }
}

function foldersPanel(): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('.ui-panel')].find((panel) =>
    panel.querySelector('.ui-panel-title')?.textContent === '資料夾',
  )!
}

function panelCreateButton(panel: HTMLElement): HTMLButtonElement {
  return panel.querySelector<HTMLButtonElement>('.ui-panel-actions button')!
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]')
}

function rowMenuTrigger(row: HTMLElement): HTMLButtonElement {
  return row.querySelector<HTMLButtonElement>('.ui-menu-wrap > button')!
}

function menuItem(label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
    (item.textContent ?? '').includes(label),
  ) ?? null
}

test('the folders panel adds from its own header, not a form sitting on the page', async () => {
  render(<AdminPage />, container)
  await settle()

  expect(dialog()).toBeNull()
  expect(container.querySelector('.ui-panel input')).toBeNull()

  panelCreateButton(foldersPanel()).click()
  await tick()

  expect(dialog()).not.toBeNull()
  expect(dialog()?.querySelector('input')).not.toBeNull()
})

test('creating posts the name typed into the dialog', async () => {
  render(<AdminPage />, container)
  await settle()

  panelCreateButton(foldersPanel()).click()
  await tick()

  const input = dialog()!.querySelector('input')!
  input.value = '20260721_soda'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()

  dialog()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  await tick()
  await tick()
  await tick()

  expect(posted).toContainEqual({ url: '/api/folders', body: { folder: '20260721_soda' } })
})

test('the dialog closes once the folder is actually created', async () => {
  render(<AdminPage />, container)
  await settle()

  panelCreateButton(foldersPanel()).click()
  await tick()

  const input = dialog()!.querySelector('input')!
  input.value = '20260721_soda'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()

  dialog()!.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  await tick()
  await tick()
  await tick()

  expect(dialog()).toBeNull()
})

test('what a folder name means is said inside the dialog, not over the whole list', async () => {
  render(<AdminPage />, container)
  await settle()

  expect(container.textContent).not.toContain('列印 API 的 id')

  panelCreateButton(foldersPanel()).click()
  await tick()

  expect(dialog()?.textContent).toContain('列印 API 的 id')
})

test('a folder row offers open, copy and delete from one menu, not three separate controls', async () => {
  folders = ['soda']
  render(<AdminPage />, container)
  await settle()

  const row = foldersPanel().querySelector('li')!
  expect(row.querySelectorAll('a, button').length).toBe(2) // the folder button itself, plus the menu trigger

  rowMenuTrigger(row).click()
  await tick()

  expect(menuItem('開啟列印頁')).not.toBeNull()
  expect(menuItem('複製網址')).not.toBeNull()
  expect(menuItem('刪除資料夾')).not.toBeNull()
})

test('there is no separate delete-folder button once a folder is open', async () => {
  /** Deleting used to live twice: once per row eventually, and once as a
   *  standing button under whichever folder happened to be selected. One
   *  operation, one place — the row's own menu is what is left. */
  folders = ['soda']
  render(<AdminPage />, container)
  await settle()

  const row = foldersPanel().querySelector('li')!
  row.querySelector('button')!.click()
  await settle()

  expect(container.textContent).not.toContain('刪除空資料夾')
})

test('a file row offers open, copy and delete from one menu too', async () => {
  folders = ['soda']
  objects = [{ key: 'soda/a.jpg', name: 'a.jpg', size: 1024 }]
  render(<AdminPage />, container)
  await settle()

  foldersPanel().querySelector<HTMLButtonElement>('.ibon-folder-name')!.click()
  await tick()
  await tick()
  await tick()

  // Scope to the files list specifically: it is the row with a thumbnail.
  const fileRow = [...container.querySelectorAll('li')].find((li) => li.querySelector('img'))!

  rowMenuTrigger(fileRow).click()
  await tick()

  expect(menuItem('開啟原始圖檔')).not.toBeNull()
  expect(menuItem('複製圖檔網址')).not.toBeNull()
  expect(menuItem('刪除圖片')).not.toBeNull()
})

test('the cache warning is not a standing banner repeated on every screen', async () => {
  /** The toast already says this the moment it actually happens — printing
   *  it permanently above every folder said it whether or not anything did. */
  folders = ['soda']
  render(<AdminPage />, container)
  await settle()

  expect(container.textContent).not.toContain('會清除這個資料夾的 pincode 快取')
  expect(container.textContent).not.toContain('規格異動會清除目前資料夾的 ibon 快取')
})

test('deleting a folder that is not the open one leaves the open one alone', async () => {
  /** Delete now happens from any row, not just the selected folder — so
   *  removing a different folder must not reset whatever is currently open. */
  folders = ['soda', 'lemon']
  render(<AdminPage />, container)
  await settle()

  const rows = [...foldersPanel().querySelectorAll('li')]
  const soda = rows.find((row) => row.textContent?.includes('soda'))!
  const lemon = rows.find((row) => row.textContent?.includes('lemon'))!

  soda.querySelector<HTMLButtonElement>('.ibon-folder-name')!.click()
  await tick()
  await tick()
  await tick()

  rowMenuTrigger(lemon).click()
  await tick()
  menuItem('刪除資料夾')!.click()
  await tick()
  container.querySelector<HTMLButtonElement>('.ui-modal button.tone-danger')!.click()
  await tick()
  await tick()
  await tick()

  expect(container.textContent).toContain('列印規格：soda')
})

test('no folder selected explains itself once, as an empty state', async () => {
  render(<AdminPage />, container)
  await settle()

  expect(container.textContent).toContain('尚未選擇資料夾')
})
