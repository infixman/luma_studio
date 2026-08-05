import { useEffect, useState } from 'preact/hooks'

import { api, apiUrl } from '../../shared/api'
import type { LearnCourse, LearnLesson } from '../../shared/types'
import { duration, fraction, inOrder, resumeAt, state } from '../lib/lessons'
import '../styles/shop.css'

/**
 * A course, before anybody presses play.
 *
 * This page exists because the player had been doing two jobs. Its sidebar was
 * the only way to see what a course contained, so the outline was a column of
 * bare titles beside a video — no pictures, no lengths, and no way to tell a
 * lesson you had finished from one you had never opened except by a tick.
 *
 * So the two jobs are two pages. This one answers "what is in here and where
 * was I", the player answers "play this". The sidebar is gone with it, which
 * is what stops the player repeating its own header back at itself.
 */
export function CoursePage({ slug }: { slug: string }) {
  const [course, setCourse] = useState<LearnCourse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api<LearnCourse>(`/api/learning/courses/${encodeURIComponent(slug)}`)
      .then(setCourse)
      .catch(() => setFailed(true))
  }, [slug])

  useEffect(() => {
    document.title = course ? `${course.title} | Luma Studio` : '課程 | Luma Studio'
  }, [course])

  if (failed) {
    return (
      <main class="shop">
        <p class="note">目前無法載入這門課程，請重新整理再試一次。</p>
      </main>
    )
  }

  if (course === null) {
    return (
      <main class="shop">
        <p class="note">載入中…</p>
      </main>
    )
  }

  const lessons = inOrder(course)
  const done = lessons.filter((lesson) => lesson.completed).length
  const resume = resumeAt(course)
  // Only worth naming when it is not simply the beginning: "從第一單元開始" is
  // what the first card already says.
  const returning = resume !== null && (resume.completed || resume.positionSeconds > 0 || done > 0)

  return (
    <main class="shop course-overview">
      <header class="course-overview-head">
        <p class="crumb">
          <a href="/account/courses">我的課程</a>
        </p>
        <h1>{course.title}</h1>
        {course.summary && <p class="summary">{course.summary}</p>}

        {lessons.length > 0 && (
          <p class="note">
            共 {lessons.length} 個單元{done > 0 && `，已完成 ${done} 個`}
          </p>
        )}

        {resume && (
          <p class="course-overview-resume">
            <a class="button" href={`/learn/${encodeURIComponent(course.slug)}/${encodeURIComponent(resume.id)}`}>
              {returning ? '繼續上課' : '開始上課'}
            </a>
          </p>
        )}
      </header>

      {lessons.length === 0 ? (
        <p class="note">這門課程還沒有單元。</p>
      ) : (
        course.sections.map((section) => (
          <section key={section.title} class="course-section">
            {/* A single chapter's name says nothing the course title has not
                said already — there is nothing for it to distinguish this
                from. */}
            {course.sections.length > 1 && <h2>{section.title}</h2>}
            <ul class="lesson-cards">
              {section.lessons.map((lesson) => (
                <li key={lesson.id}>
                  <LessonCard slug={course.slug} lesson={lesson} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  )
}

function LessonCard({ slug, lesson }: { slug: string; lesson: LearnLesson }) {
  const where = state(lesson)
  const through = fraction(lesson)

  return (
    <a class="lesson-card" href={`/learn/${encodeURIComponent(slug)}/${encodeURIComponent(lesson.id)}`}>
      <span class="lesson-card-cover">
        {/* Decorative: the title is in the same link, and reading the lesson
            name twice helps nobody. */}
        {lesson.coverPath ? (
          <img src={apiUrl(lesson.coverPath)} alt="" loading="lazy" />
        ) : (
          <span class="lesson-card-blank" aria-hidden="true" />
        )}

        {lesson.durationSeconds !== null && (
          <span class="lesson-card-length">{duration(lesson.durationSeconds)}</span>
        )}

        {/* Over the picture, where the eye already is. A bar under the title
            competes with the title. */}
        {through !== null && through > 0 && (
          <span class="lesson-card-bar" aria-hidden="true">
            <span class="fill" style={{ inlineSize: `${through * 100}%` }} />
          </span>
        )}
      </span>

      <span class="lesson-card-body">
        <span class="title">{lesson.title}</span>
        <span class={`lesson-card-state is-${where}`}>
          {where === 'done' && '已完成'}
          {/* Where to pick it up, not merely that it was opened. "已開始" is a
              fact about the past; a timestamp is somewhere to go back to. */}
          {where === 'partway' && `看到 ${duration(lesson.positionSeconds)}`}
          {where === 'new' && (lesson.hasVideo ? '尚未觀看' : '尚未閱讀')}
        </span>
      </span>
    </a>
  )
}
