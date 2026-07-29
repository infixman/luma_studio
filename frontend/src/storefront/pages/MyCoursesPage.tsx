import { useEffect, useState } from 'preact/hooks'

import { api } from '../../shared/api'
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
          {courses.map((course) => (
            <li key={course.id}>
              <a class="course-card" href={`/learn/${encodeURIComponent(course.slug)}`}>
                <span class="title">{course.title}</span>
                {course.completedCount > 0 && (
                  <span class="note">已完成 {course.completedCount} 個單元</span>
                )}
                {/* "開始上課" on something half-watched reads as though the
                    progress was lost. */}
                <span class="cta">{course.lastViewedAt === null ? '開始上課' : '繼續上課'}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
