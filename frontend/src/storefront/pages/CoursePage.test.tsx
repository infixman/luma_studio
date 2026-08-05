// @vitest-environment happy-dom

/**
 * A course, before anybody presses play.
 *
 * This page exists because the player was doing two jobs: its sidebar was the
 * only way to see what a course contained, so the contents were a column of
 * bare titles beside a video — no pictures, no lengths, and nothing to tell a
 * finished lesson from one never opened.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { LearnCourse, LearnLesson } from '../../shared/types'

const API_ORIGIN = 'https://api.example.test'

function aLesson(overrides: Partial<LearnLesson> = {}): LearnLesson {
  return {
    id: 'lesson-1',
    title: '調色',
    contentHtml: '',
    hasVideo: true,
    isPreview: false,
    completed: false,
    positionSeconds: 0,
    durationSeconds: 192,
    coverPath: '/api/learning/lessons/lesson-1/poster',
    ...overrides,
  }
}

let course: LearnCourse = {
  title: '水彩入門',
  slug: 'watercolour',
  summary: '',
  sections: [{ title: '第一章', lessons: [aLesson()] }],
}

vi.mock('../../shared/api', () => ({
  api: vi.fn(async () => course),
  apiUrl: (path: string) => `${API_ORIGIN}${path}`,
}))

import { CoursePage } from './CoursePage'

let container: HTMLDivElement

beforeEach(() => {
  course = {
    title: '水彩入門',
    slug: 'watercolour',
    summary: '',
    sections: [{ title: '第一章', lessons: [aLesson()] }],
  }
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function show() {
  render(<CoursePage slug="watercolour" />, container)
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a lesson is a card with its picture, its length and a way in', async () => {
  await show()

  const card = container.querySelector('.lesson-card')!
  expect(card.getAttribute('href')).toBe('/learn/watercolour/lesson-1')
  expect(card.querySelector('img')?.getAttribute('src')).toBe(
    `${API_ORIGIN}/api/learning/lessons/lesson-1/poster`,
  )
  expect(card.textContent).toContain('3:12')
})

test('a lesson with no picture still keeps its shape', async () => {
  // A reading has no frame to take one from. The placeholder is what stops one
  // missing picture making one card a different size from the rest.
  course.sections[0]!.lessons = [aLesson({ coverPath: null, hasVideo: false, durationSeconds: null })]

  await show()

  expect(container.querySelector('.lesson-card-blank')).not.toBeNull()
  expect(container.querySelector('.lesson-card img')).toBeNull()
})

test('a lesson left partway says where to pick it up', async () => {
  /** "已開始" is a fact about the past; a timestamp is somewhere to go back to. */
  course.sections[0]!.lessons = [aLesson({ positionSeconds: 75 })]

  await show()

  expect(container.querySelector('.lesson-card-state')?.textContent).toContain('看到 1:15')
  expect(container.querySelector('.lesson-card-bar')).not.toBeNull()
})

test('a finished lesson says so rather than showing a position', async () => {
  course.sections[0]!.lessons = [aLesson({ completed: true, positionSeconds: 190 })]

  await show()

  const state = container.querySelector('.lesson-card-state')!
  expect(state.textContent).toContain('已完成')
  expect(state.textContent).not.toContain('看到')
})

test('a lesson never opened has no progress bar over its picture', async () => {
  await show()

  expect(container.querySelector('.lesson-card-bar')).toBeNull()
  expect(container.querySelector('.lesson-card-state')?.textContent).toContain('尚未觀看')
})

test('the way in resumes at the first unfinished lesson', async () => {
  course.sections[0]!.lessons = [
    aLesson({ id: 'a', completed: true }),
    aLesson({ id: 'b' }),
  ]

  await show()

  const resume = container.querySelector('.course-overview-resume a')!
  expect(resume.getAttribute('href')).toBe('/learn/watercolour/b')
  expect(resume.textContent).toContain('繼續上課')
})

test('a course nobody has started says start rather than continue', async () => {
  await show()

  expect(container.querySelector('.course-overview-resume a')?.textContent).toContain('開始上課')
})

test('a single chapter is not given a heading of its own', async () => {
  /** There is nothing for it to distinguish the lessons from, and the course
   *  title above has already said it — which is exactly what looked duplicated
   *  when the contents were a sidebar. */
  await show()

  expect(container.querySelector('.course-section h2')).toBeNull()
})

test('chapters are named once there is more than one', async () => {
  course.sections = [
    { title: '第一章', lessons: [aLesson({ id: 'a' })] },
    { title: '第二章', lessons: [aLesson({ id: 'b' })] },
  ]

  await show()

  expect([...container.querySelectorAll('.course-section h2')].map((h) => h.textContent)).toEqual([
    '第一章',
    '第二章',
  ])
})

test('a course with no lessons says so instead of showing an empty grid', async () => {
  course.sections = []

  await show()

  expect(container.textContent).toContain('這門課程還沒有單元')
})
