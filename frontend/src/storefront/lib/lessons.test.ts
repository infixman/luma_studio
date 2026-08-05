import { describe, expect, it } from 'vitest'

import type { LearnCourse, LearnLesson } from '../../shared/types'
import { duration, fraction, resumeAt, state } from './lessons'

function aLesson(overrides: Partial<LearnLesson> = {}): LearnLesson {
  return {
    id: 'lesson-1',
    title: '調色',
    contentHtml: '',
    hasVideo: true,
    isPreview: false,
    completed: false,
    positionSeconds: 0,
    durationSeconds: 600,
    coverPath: null,
    ...overrides,
  }
}

function aCourse(lessons: LearnLesson[]): LearnCourse {
  return { title: '水彩入門', slug: 'watercolour', summary: '', sections: [{ title: '第一章', lessons }] }
}

describe('how long a lesson runs', () => {
  it('reads as a length, not as a clock', () => {
    // 3:12 rather than 03:12. The leading zero is what makes it look like a
    // time of day.
    expect(duration(192)).toBe('3:12')
  })

  it('grows an hours field only when there is an hour', () => {
    expect(duration(3753)).toBe('1:02:33')
    expect(duration(59)).toBe('0:59')
  })

  it('does not print a negative or a fraction of a second', () => {
    expect(duration(-5)).toBe('0:00')
    expect(duration(61.7)).toBe('1:01')
  })
})

describe('what the member has done with a lesson', () => {
  it('calls a finished lesson finished even though it also has a position', () => {
    // Watching to the end leaves both. "已完成" is the answer they want.
    expect(state(aLesson({ completed: true, positionSeconds: 300 }))).toBe('done')
  })

  it('tells a lesson left partway from one never opened', () => {
    expect(state(aLesson({ positionSeconds: 42 }))).toBe('partway')
    expect(state(aLesson())).toBe('new')
  })
})

describe('how far through', () => {
  it('is nothing to divide by on a reading', () => {
    expect(fraction(aLesson({ durationSeconds: null, hasVideo: false }))).toBeNull()
  })

  it('is full once finished, whatever the position says', () => {
    expect(fraction(aLesson({ completed: true, positionSeconds: 1 }))).toBe(1)
  })

  it('never runs past the end of its own track', () => {
    /** A saved position outlives the video it was saved against: re-encode a
     *  lesson shorter and the old position is past the end. A bar drawn past
     *  its track looks like a rendering fault rather than stale data. */
    expect(fraction(aLesson({ positionSeconds: 900, durationSeconds: 600 }))).toBe(1)
  })
})

describe('where to pick a course up', () => {
  it('is the first unfinished lesson, not the first lesson', () => {
    const course = aCourse([
      aLesson({ id: 'a', completed: true }),
      aLesson({ id: 'b' }),
      aLesson({ id: 'c' }),
    ])

    expect(resumeAt(course)?.id).toBe('b')
  })

  it('is the last one when everything is finished', () => {
    // They are revisiting, and the end is where they left off.
    const course = aCourse([aLesson({ id: 'a', completed: true }), aLesson({ id: 'b', completed: true })])

    expect(resumeAt(course)?.id).toBe('b')
  })

  it('is nothing at all for a course with no lessons', () => {
    expect(resumeAt(aCourse([]))).toBeNull()
  })
})
