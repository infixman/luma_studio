// @vitest-environment happy-dom

/**
 * Writing a course's chapters and lessons.
 *
 * The whole tree is sent as one thing, because that is how the server replaces
 * it. So this component holds a draft and the page saves it — a per-row save
 * would leave an outline half-changed on any failed request.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CourseSection, VideoAsset } from '../../../shared/types'

const READY_ASSET: VideoAsset = {
  id: 'asset-1',
  title: '第一課影片',
  originalFilename: 'lesson-01.mp4',
  status: 'ready',
  byteSize: 1000,
  durationSeconds: 600,
  width: 1920,
  height: 1080,
  encodeVersion: 1,
  hasPoster: false,
  errorCode: null,
  errorDetail: null,
  createdAt: 0,
  updatedAt: 0,
}

// The route already filters by status; the component filters again because a
// response is not a promise about its own query string.
vi.mock('../../../shared/api', () => ({
  api: vi.fn(async () => ({
    assets: [
      READY_ASSET,
      { ...READY_ASSET, id: 'asset-2', title: '還在轉檔', status: 'processing', encodeVersion: null },
    ],
  })),
}))

import { CourseOutlineEditor } from './CourseOutlineEditor'

let container: HTMLDivElement
let saved: CourseSection[] | null = null

function outline(): CourseSection[] {
  return [
    {
      id: 's1',
      title: '第一章',
      position: 0,
      lessons: [
        { id: 'l1', title: '工具介紹', contentHtml: '', videoAssetId: 'asset-1', isPreview: false, position: 0 },
        { id: 'l2', title: '調色練習', contentHtml: '', videoAssetId: null, isPreview: false, position: 1 },
      ],
    },
  ]
}

function show(sections: CourseSection[]) {
  render(<CourseOutlineEditor sections={sections} onChange={(next) => (saved = next)} />, container)
}

beforeEach(() => {
  saved = null
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 10; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function clickLabelled(label: string) {
  const button = [...container.querySelectorAll('button')].find((entry) =>
    (entry.getAttribute('aria-label') ?? entry.textContent ?? '').includes(label),
  )
  if (!button) throw new Error(`no button for ${label}`)
  button.click()
}

test('a chapter can be added', async () => {
  show([])
  await settle()

  clickLabelled('新增章節')

  expect(saved).toHaveLength(1)
  expect(saved![0]!.lessons).toEqual([])
})

test('a lesson can be added to a chapter', async () => {
  show(outline())
  await settle()

  clickLabelled('在「第一章」新增單元')

  expect(saved![0]!.lessons).toHaveLength(3)
})

test('a lesson can be removed', async () => {
  show(outline())
  await settle()

  clickLabelled('移除單元「調色練習」')

  expect(saved![0]!.lessons.map((lesson) => lesson.title)).toEqual(['工具介紹'])
})

test('a lesson can be moved down, and positions are renumbered', async () => {
  // Positions are what the server stores order by, so a move that reorders the
  // array without renumbering would save the old order.
  show(outline())
  await settle()

  clickLabelled('將「工具介紹」往下移')

  expect(saved![0]!.lessons.map((lesson) => lesson.title)).toEqual(['調色練習', '工具介紹'])
  expect(saved![0]!.lessons.map((lesson) => lesson.position)).toEqual([0, 1])
})

test('the first lesson cannot be moved up', async () => {
  show(outline())
  await settle()

  const up = [...container.querySelectorAll('button')].find((entry) =>
    (entry.getAttribute('aria-label') ?? '').includes('將「工具介紹」往上移'),
  )!

  expect(up.disabled).toBe(true)
})

test('removing a chapter says how many lessons go with it', async () => {
  // Not obvious, and not recoverable, so the confirmation says it rather than
  // letting somebody find out.
  show(outline())
  await settle()

  clickLabelled('移除章節「第一章」')
  await settle()

  expect(container.textContent).toContain('2 個單元會一起移除')
})

test('a chapter is only removed once the confirmation is accepted', async () => {
  show(outline())
  await settle()

  clickLabelled('移除章節「第一章」')
  await settle()
  clickLabelled('移除')
  await settle()

  expect(saved).toEqual([])
})

test('only a finished video can be chosen for a lesson', async () => {
  // A lesson pointing at something still encoding cannot be published, so
  // offering it here would only produce an error later.
  show(outline())
  await settle()

  // The picker is a listbox rather than a native select, so its options only
  // exist once it is open.
  const picker = [...container.querySelectorAll('button')].find((entry) =>
    (entry.getAttribute('aria-haspopup') ?? '') === 'listbox',
  )!
  picker.click()
  await settle()

  const options = [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? '')

  expect(options.some((text) => text.includes('第一課影片'))).toBe(true)
  expect(options.some((text) => text.includes('還在轉檔'))).toBe(false)
})

test('a lesson can be marked as free to watch', async () => {
  show(outline())
  await settle()

  const preview = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  preview.checked = true
  preview.dispatchEvent(new Event('change', { bubbles: true }))

  expect(saved![0]!.lessons[0]!.isPreview).toBe(true)
})
