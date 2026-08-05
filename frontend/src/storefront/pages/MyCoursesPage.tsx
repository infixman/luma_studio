import { useEffect, useState } from 'preact/hooks'

import { api, apiUrl } from '../../shared/api'
import type { EnrolledCourse } from '../../shared/types'
import '../styles/shop.css'

/**
 * What a member owns.
 *
 * The list comes from entitlements, not from scanning old orders. A course
 * bought, refunded and bought again appears once; a course refunded does not
 * appear at all, even though the order it came from still exists and is still
 * visible under 我的訂單.
 */
export function MyCoursesPage() {
  const [courses, setCourses] = useState<EnrolledCourse[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    document.title = '我的課程 | Luma Studio'
    api<{ courses: EnrolledCourse[] }>('/api/learning/courses')
      .then((data) => setCourses(data.courses))
      .catch(() => setFailed(true))
  }, [])

  if (failed) {
    return (
      <main class="shop">
        <h1>我的課程</h1>
        <p class="note">目前無法載入課程，請重新整理再試一次。</p>
      </main>
    )
  }

  if (courses === null) {
    return (
      <main class="shop">
        <h1>我的課程</h1>
        <p class="note">載入中…</p>
      </main>
    )
  }

  return (
    <main class="shop">
      <h1>我的課程</h1>

      {courses.length === 0 ? (
        // Somewhere to go, rather than an empty page that reads as a fault.
        <div class="empty">
          <p>還沒有課程。</p>
          <p>
            <a href="/shop">去商城看看</a>
          </p>
        </div>
      ) : (
        <ul class="course-cards">
          {courses.map((course) => {
            const done = Math.min(course.completedCount, course.lessonCount)
            const finished = course.lessonCount > 0 && done >= course.lessonCount
            return (
              <li key={course.id}>
                <a class="course-card" href={`/learn/${encodeURIComponent(course.slug)}`}>
                  {/* Decorative: the title is in the same link, and reading the
                      course name twice helps nobody. */}
                  <span class="course-card-cover">
                    {course.coverPath ? (
                      <img src={apiUrl(course.coverPath)} alt="" loading="lazy" />
                    ) : (
                      <span class="course-card-blank" aria-hidden="true" />
                    )}
                    {finished && <span class="course-card-flag">已完成</span>}
                  </span>

                  <span class="course-card-body">
                    <span class="title">{course.title}</span>
                    {course.summary && <span class="summary">{course.summary}</span>}

                    {/* A bare "已完成 3 個單元" says nothing about whether that
                        is nearly done or barely started, which is the one thing
                        worth knowing at a glance. */}
                    {course.lessonCount > 0 && (
                      <span class="course-card-progress">
                        <span
                          class="bar"
                          role="progressbar"
                          aria-valuenow={done}
                          aria-valuemin={0}
                          aria-valuemax={course.lessonCount}
                          aria-label={`已完成 ${done} / ${course.lessonCount} 個單元`}
                        >
                          <span class="fill" style={{ inlineSize: `${(done / course.lessonCount) * 100}%` }} />
                        </span>
                        <span class="note">
                          {done} / {course.lessonCount} 個單元
                        </span>
                      </span>
                    )}

                    {/* "開始上課" on something half-watched reads as though the
                        progress was lost. */}
                    <span class="cta">
                      {finished ? '再看一次' : course.lastViewedAt === null ? '開始上課' : '繼續上課'}
                    </span>
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
