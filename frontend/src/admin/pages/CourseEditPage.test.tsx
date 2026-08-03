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
      // The outline editor offers finished videos to choose from.
      if (url.startsWith('/api/video-assets')) return { assets: [] }
      if (url.startsWith('/api/media/tags')) return { tags: [] }
      if (url.startsWith('/api/media'))
        return {
          media: [
            {
              id: 'media-2', path: '/media-assets/picked.webp', fileName: 'picked.webp',
              title: '', alt: '', tags: [], byteSize: 1, width: 100, height: 100,
              sizes: [], createdAt: 1,
            },
          ],
          page: 1,
          pages: 1,
          total: 1,
          perPage: 24,
          count: 1,
        }
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

test('an outline is shown chapter by chapter, as editable rows', async () => {
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

  // A TextField renders a bare `input` with no explicit type, so this reads
  // every one rather than filtering by a type that is not there.
  const values = [...container.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value)
  expect(values).toContain('第一章')
  expect(values).toContain('工具介紹')
  expect(values).toContain('調色練習')
})

test('a lesson anybody can watch is ticked', async () => {
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

  const preview = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(preview?.checked).toBe(true)
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

test('the cover is drawn from the path the server resolved', async () => {
  /** The page used to build `/media-assets/{coverMediaId}` itself, which is not
   *  where anything is served — the URL comes from the object key, and only the
   *  library knows it. Every course with a cover showed a broken-image icon. */
  course = aCourse({ coverMediaId: 'media-1', coverPath: '/media-assets/abc123.webp' })

  render(<CourseEditPage id="c1" />, container)
  await settle()

  const cover = container.querySelector<HTMLImageElement>('.course-cover img')
  expect(cover?.getAttribute('src')).toContain('/media-assets/abc123.webp')
  expect(cover?.getAttribute('src')).not.toContain('media-1')
})

test('picking a cover shows that picture rather than waiting for a save', async () => {
  /** The path comes from the server, and the picked item already carries it —
   *  so the preview is the picture just chosen. Setting only the id would leave
   *  the page with a cover it cannot draw until somebody reloads. */
  course = aCourse({ coverMediaId: null, coverPath: null })

  render(<CourseEditPage id="c1" />, container)
  await settle()

  const choose = [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes('選擇封面'),
  )
  choose?.click()
  // The picker debounces its search by 250ms, so the grid arrives later than
  // the dialog does.
  await new Promise((resolve) => setTimeout(resolve, 320))
  await settle()

  const picked = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (element) => element.querySelector('img'),
  )
  expect(picked, 'the picker showed no pictures to choose from').toBeTruthy()
  picked?.click()
  await settle()

  expect(container.querySelector<HTMLImageElement>('.course-cover img')?.getAttribute('src')).toContain(
    '/media-assets/picked.webp',
  )
})

test('publishing is refused while there are unsaved edits, and says why', async () => {
  /** Publishing reads the server. With unsaved edits it publishes the last
   *  saved version — and refuses on fields the author has already filled in,
   *  which is how "請填寫課程簡介" appeared next to a filled-in 課程簡介. The
   *  block editor's publish button has disabled itself on this rule for as long
   *  as it has existed; this page never learned it. */
  course = aCourse({ status: 'draft', summary: '' })

  render(<CourseEditPage id="c1" />, container)
  await settle()

  const summary = [...container.querySelectorAll('label')]
    .find((label) => (label.textContent ?? '').includes('課程簡介'))
    ?.parentElement?.querySelector('input') as HTMLInputElement
  summary.value = '來畫夜光海浪'
  summary.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()

  const publish = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === '發布',
  )
  expect(publish?.disabled).toBe(true)
  expect(publish?.title).toContain('儲存')
})

/**
 * One prose field, not six.
 *
 * The editor asked for 你將學會, 適合對象, 課程介紹, 先備知識, 需要準備的工具
 * 或材料 and 講師介紹 as six separate rich-text panels — and two of them,
 * 先備知識 and 需要準備的工具或材料, were never rendered on the product page
 * at all, so they were collected and thrown away. Course pages elsewhere put
 * all of this in one image inside the description, which is one field.
 */
test('the editor asks for the description and nothing else in prose', async () => {
  render(<CourseEditPage id="c1" />, container)
  await settle()

  const titles = [...container.querySelectorAll('.ui-panel-title')].map((h) => h.textContent?.trim())
  expect(titles).toContain('課程介紹')
  for (const gone of ['你將學會', '適合對象', '先備知識', '需要準備的工具或材料', '講師介紹']) {
    expect(titles).not.toContain(gone)
  }
})
