// @vitest-environment happy-dom

/**
 * The course editor.
 *
 * Two things it has to get right. Publishing shows every reason it cannot,
 * not the first one — an author who fixes one thing per attempt gives up. And
 * the outline is saved as a whole, because that is how the server replaces it.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Course, CourseSection } from '../../shared/types'
import { aCourse } from '../../shared/testing/fixtures'

let course: Course = aCourse({ status: 'draft' })
let sections: CourseSection[] = []
let publishProblems: { field: string; message: string }[] = []

// The real ApiError, so `instanceof` in the page means what it says. Only the
// two call functions are replaced.
vi.mock('../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api')>()
  return {
    ...actual,
    api: vi.fn(async (url: string) => {
      if (url.endsWith('/outline')) return { sections }
      return { course }
    }),
    apiJson: vi.fn(async (url: string) => {
      if (url.endsWith('/publish') && publishProblems.length > 0) {
        throw new actual.ApiError('課程尚未符合發布條件', 409, { problems: publishProblems })
      }
      if (url.endsWith('/publish')) return { course: { ...course, status: 'published' } }
      if (url.endsWith('/outline')) return { sections }
      return { course }
    }),
  }
})

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { CourseEditPage } from './CourseEditPage'

let container: HTMLDivElement

beforeEach(() => {
  course = aCourse({ status: 'draft' })
  sections = []
  publishProblems = []
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 30; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

function clickText(label: string) {
  const button = [...container.querySelectorAll('button')].find((entry) =>
    (entry.textContent ?? '').includes(label),
  )
  if (!button) throw new Error(`no button labelled ${label}`)
  button.click()
}

test('a draft course says so', async () => {
  render(<CourseEditPage id="course-1" />, container)
  await settle()

  expect(container.textContent).toContain('草稿')
})

test('every reason a course cannot be published is shown at once', async () => {
  publishProblems = [
    { field: 'summary', message: '請填寫課程簡介，商品頁會用它開頭' },
    { field: 'cover', message: '請選擇課程封面' },
    { field: 'video', message: '單元「調色練習」的影片尚未轉檔完成' },
  ]

  render(<CourseEditPage id="course-1" />, container)
  await settle()
  clickText('發布')
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(container.textContent).toContain('請填寫課程簡介')
  expect(container.textContent).toContain('請選擇課程封面')
  expect(container.textContent).toContain('調色練習')
})

test('an outline is shown chapter by chapter', async () => {
  sections = [
    {
      id: 's1',
      title: '第一章',
      position: 0,
      lessons: [
        { id: 'l1', title: '工具介紹', contentHtml: '', videoAssetId: 'asset-1', isPreview: true, position: 0 },
        { id: 'l2', title: '調色練習', contentHtml: '', videoAssetId: null, isPreview: false, position: 1 },
      ],
    },
  ]

  render(<CourseEditPage id="course-1" />, container)
  await settle()

  expect(container.textContent).toContain('第一章')
  expect(container.textContent).toContain('工具介紹')
  expect(container.textContent).toContain('調色練習')
})

test('a lesson anybody can watch is marked as such', async () => {
  // Preview is the one lesson property with a consequence outside the editor:
  // it is watchable without buying.
  sections = [
    {
      id: 's1',
      title: '第一章',
      position: 0,
      lessons: [
        { id: 'l1', title: '工具介紹', contentHtml: '', videoAssetId: 'asset-1', isPreview: true, position: 0 },
      ],
    },
  ]

  render(<CourseEditPage id="course-1" />, container)
  await settle()

  expect(container.textContent).toContain('試看')
})

test('a lesson with no video is not shown as broken', async () => {
  // A reading is a valid lesson, and "no video" must not read as an error.
  sections = [
    {
      id: 's1',
      title: '第一章',
      position: 0,
      lessons: [
        { id: 'l1', title: '課前準備', contentHtml: '<p>請準備</p>', videoAssetId: null, isPreview: false, position: 0 },
      ],
    },
  ]

  render(<CourseEditPage id="course-1" />, container)
  await settle()

  expect(container.textContent).toContain('文字單元')
})
