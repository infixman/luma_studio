import type { LearnCourse, LearnLesson } from '../../shared/types'

/**
 * The small facts about a lesson that both halves of `/learn` need to say.
 *
 * Here rather than in either page because the overview and the player disagree
 * about almost everything else, and these are the parts they must not disagree
 * about: how long a lesson is, and how far through it somebody got.
 */

/**
 * `3:12`, or `1:02:33` once there is an hour to show.
 *
 * Minutes stay unpadded at the top so a three minute lesson reads as 3:12
 * rather than 03:12, which is a clock rather than a length.
 */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

export type LessonState = 'done' | 'partway' | 'new'

/**
 * What the member has done with this lesson.
 *
 * Finished wins over a position, because a position is left behind by
 * finishing: somebody who watched to the end has both, and "已完成" is the
 * answer they are looking for.
 */
export function state(lesson: LearnLesson): LessonState {
  if (lesson.completed) return 'done'
  return lesson.positionSeconds > 0 ? 'partway' : 'new'
}

/**
 * How far through, 0 to 1, or null when there is nothing to divide by.
 *
 * Clamped, because a saved position can outlive the video it was saved
 * against — re-encode a lesson shorter and the old position is past the end.
 * A bar drawn past its own track looks like a rendering fault rather than
 * stale data.
 */
export function fraction(lesson: LearnLesson): number | null {
  if (lesson.completed) return 1
  if (!lesson.durationSeconds || lesson.durationSeconds <= 0) return null
  if (lesson.positionSeconds <= 0) return 0
  return Math.min(1, lesson.positionSeconds / lesson.durationSeconds)
}

/** Every lesson in the course, in the order somebody watches them. */
export function inOrder(course: LearnCourse): LearnLesson[] {
  return course.sections.flatMap((section) => section.lessons)
}

/**
 * Where to send somebody who opened the course rather than a lesson.
 *
 * The first unfinished one, because a course is something you come back to and
 * the thing you came back for is the next bit. Everything finished means the
 * last one — they are revisiting, and the end is where they left off.
 */
export function resumeAt(course: LearnCourse): LearnLesson | null {
  const lessons = inOrder(course)
  if (lessons.length === 0) return null
  return lessons.find((lesson) => !lesson.completed) ?? lessons[lessons.length - 1]!
}
