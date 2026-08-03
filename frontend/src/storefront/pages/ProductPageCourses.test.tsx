// @vitest-environment happy-dom

/**
 * A product page for something that grants a course.
 *
 * The page has to say enough that somebody can decide to buy: what they will
 * learn, who teaches it, how much there is. What it must not do is hand over
 * the lessons themselves, which are the thing being sold.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { PublicCourse, PublicProductDetail } from '../../shared/types'
import { aPublicProduct, aPublicVariant } from '../../shared/testing/fixtures'

function aPublicCourse(overrides: Partial<PublicCourse> = {}): PublicCourse {
  return {
    slug: 'watercolour',
    title: '水彩花卉入門',
    summary: '兩小時學會水彩花卉',
    descriptionHtml: '<p>課程介紹</p>',
    instructorName: '王老師',
    level: 'beginner',
    language: 'zh-Hant',
    lessonCount: 12,
    sections: [
      {
        title: '第一章',
        lessons: [
          { id: 'l1', title: '工具介紹', isPreview: true, hasVideo: true },
          { id: 'l2', title: '調色練習', isPreview: false, hasVideo: true },
        ],
      },
    ],
    ...overrides,
  }
}

let product: PublicProductDetail = aPublicProduct()

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => product),
  apiJson: vi.fn(async () => product),
  apiUrl: (path: string) => path,
}))

vi.mock('../lib/cart', () => ({ add: vi.fn(), read: () => [], MAX_QUANTITY: 100000 }))

import { ProductPage } from './ProductPage'

let container: HTMLDivElement

beforeEach(() => {
  product = aPublicProduct()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test('an ordinary product shows no course section at all', async () => {
  product = aPublicProduct({ variants: [aPublicVariant()] })

  render(<ProductPage slug="soda-tote" />, container)
  await settle()

  expect(container.textContent).not.toContain('課程大綱')
})

test('a course product says what it teaches and how much there is', async () => {
  product = aPublicProduct({
    variants: [aPublicVariant()],
    containsCourse: true,
    courses: [aPublicCourse()],
  })

  render(<ProductPage slug="watercolour" />, container)
  await settle()

  expect(container.textContent).toContain('水彩花卉入門')
  expect(container.textContent).toContain('王老師')
  expect(container.textContent).toContain('12')
  expect(container.textContent).toContain('課程大綱')
})

test('every lesson is named so a buyer knows what is covered', async () => {
  product = aPublicProduct({ variants: [aPublicVariant()], containsCourse: true, courses: [aPublicCourse()] })

  render(<ProductPage slug="watercolour" />, container)
  await settle()

  expect(container.textContent).toContain('工具介紹')
  expect(container.textContent).toContain('調色練習')
})

test('a lesson anybody can watch is marked as such', async () => {
  product = aPublicProduct({ variants: [aPublicVariant()], containsCourse: true, courses: [aPublicCourse()] })

  render(<ProductPage slug="watercolour" />, container)
  await settle()

  expect(container.textContent).toContain('試看')
})

test('a bundle of two courses lists both', async () => {
  // "This plan includes" — not one course quietly standing in for the rest.
  product = aPublicProduct({
    variants: [aPublicVariant()],
    containsCourse: true,
    courses: [aPublicCourse(), aPublicCourse({ slug: 'roses', title: '玫瑰進階' })],
  })

  render(<ProductPage slug="bundle" />, container)
  await settle()

  expect(container.textContent).toContain('水彩花卉入門')
  expect(container.textContent).toContain('玫瑰進階')
})

/**
 * The course sells itself with one block of prose, not five headings.
 *
 * The page used to head 你將學會, 適合對象, 課程介紹 and 關於講師 separately,
 * from four fields the back office asked for one at a time. Course pages
 * elsewhere put all of that into one image inside the description, so that is
 * the field that stayed.
 */
test('the course shows its description without the four headings around it', async () => {
  product = aPublicProduct({ variants: [aPublicVariant()], containsCourse: true, courses: [aPublicCourse()] })

  render(<ProductPage slug="watercolour" />, container)
  await settle()

  expect(container.textContent).toContain('課程介紹')
  for (const gone of ['你將學會', '適合對象', '關於講師']) {
    expect(container.textContent).not.toContain(gone)
  }
})
