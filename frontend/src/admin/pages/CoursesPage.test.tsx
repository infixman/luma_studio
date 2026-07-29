// @vitest-environment happy-dom

/**
 * Courses as things an offer can point at.
 *
 * The status is the load-bearing part of this screen: an offer granting a
 * draft course sells access to nothing, so a draft has to be visibly a draft
 * rather than look like everything else in the list.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Course } from '../../shared/types'
import { aCourse } from '../../shared/testing/fixtures'

const COURSE: Course = aCourse({ status: 'draft' })

let courses: Course[] = []

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => ({ courses })),
  apiJson: vi.fn(async () => ({ course: COURSE })),
}))

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { CoursesPage } from './CoursesPage'

let container: HTMLDivElement

beforeEach(() => {
  courses = []
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle() {
  for (let tick = 0; tick < 50; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

test('a draft course is labelled as one', async () => {
  courses = [COURSE]

  render(<CoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('水彩花卉入門')
  expect(container.textContent).toContain('草稿')
})

test('a published course is labelled as published', async () => {
  courses = [{ ...COURSE, status: 'published' }]

  render(<CoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('已發布')
})

test('an empty list says what a course is for here', async () => {
  render(<CoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('還沒有課程')
})

test('a slug is derived from the title when none is given', async () => {
  // Asking for a URL segment before the admin has thought about one is a
  // step they will skip badly. The server would refuse a bad slug, so the
  // page fills in a usable one.
  const { apiJson } = await import('../../shared/api')

  render(<CoursesPage />, container)
  await settle()

  const [title] = [...container.querySelectorAll<HTMLInputElement>('input')]
  title!.value = 'Watercolour Flowers'
  title!.dispatchEvent(new Event('input', { bubbles: true }))
  // Preact batches, so the typed value is not in state until it re-renders.
  await new Promise((resolve) => setTimeout(resolve, 0))

  container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(vi.mocked(apiJson).mock.calls[0]![2]).toMatchObject({ slug: 'watercolour-flowers' })
})
