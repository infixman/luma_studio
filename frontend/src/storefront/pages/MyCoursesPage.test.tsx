// @vitest-environment happy-dom

/**
 * What a member owns.
 *
 * The list comes from entitlements, not from scanning old orders. A course
 * bought, refunded and bought again should appear once; a course refunded
 * should not appear at all, even though the order still exists.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { EnrolledCourse } from '../../shared/types'

let courses: EnrolledCourse[] = []

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => ({ courses })),
  apiUrl: (path: string) => path,
}))

import { MyCoursesPage } from './MyCoursesPage'

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
  for (let tick = 0; tick < 20; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

test('a member with no courses is pointed at the shop rather than left blank', async () => {
  render(<MyCoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('還沒有課程')
  const links = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))
  expect(links).toContain('/shop')
})

test('a course is listed with a way into it', async () => {
  courses = [{ id: 'c1', slug: 'watercolour', title: '水彩花卉入門', completedCount: 0, lastViewedAt: null }]

  render(<MyCoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('水彩花卉入門')
  const links = [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))
  expect(links).toContain('/learn/watercolour')
})

test('a course already started says continue rather than start', async () => {
  // Small difference, but "開始上課" on something half-watched reads as though
  // the progress was lost.
  courses = [{ id: 'c1', slug: 'watercolour', title: '水彩花卉入門', completedCount: 3, lastViewedAt: 1000 }]

  render(<MyCoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('繼續上課')
})

test('a course not yet started says start', async () => {
  courses = [{ id: 'c1', slug: 'watercolour', title: '水彩花卉入門', completedCount: 0, lastViewedAt: null }]

  render(<MyCoursesPage />, container)
  await settle()

  expect(container.textContent).toContain('開始上課')
})
