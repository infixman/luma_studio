import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Badge, Button, EmptyState, Panel, Select, Spinner, TextField } from '../components/ui'
import type { BadgeTone } from '../components/ui'
import { ApiError, api, apiJson } from '../../shared/api'
import type {
  Course,
  CourseLevel,
  CoursePublishProblem,
  CourseSection,
  CourseStatus,
} from '../../shared/types'
import '../styles/shop-admin.css'

const STATUS_LABELS: Record<CourseStatus, string> = {
  draft: '草稿',
  published: '已發布',
  archived: '已封存',
}

const STATUS_TONES: Record<CourseStatus, BadgeTone> = {
  draft: 'neutral',
  published: 'success',
  archived: 'warning',
}

const LEVEL_LABELS: Record<CourseLevel, string> = {
  beginner: '入門',
  intermediate: '進階',
  advanced: '專業',
  all: '不限程度',
}

/**
 * Writing a course.
 *
 * Publishing shows every reason it cannot rather than the first: an author
 * who fixes one thing per attempt, and only then learns about the next, gives
 * up somewhere around the third.
 *
 * The outline is displayed here and edited as a whole, matching how the
 * server replaces it. A lesson with no video is a reading and says so — "no
 * video" must not read as something broken.
 */
export function CourseEditPage({ id }: { id: string }) {
  const [course, setCourse] = useState<Course | null>(null)
  const [sections, setSections] = useState<CourseSection[]>([])
  const [problems, setProblems] = useState<CoursePublishProblem[]>([])
  const { message, showError, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      const [detail, outline] = await Promise.all([
        api<{ course: Course }>(`/api/courses/${encodeURIComponent(id)}`),
        api<{ sections: CourseSection[] }>(`/api/courses/${encodeURIComponent(id)}/outline`),
      ])
      setCourse(detail.course)
      setSections(outline.sections)
    } catch (error) {
      showError(error)
    }
  }, [id, showError])

  useEffect(() => {
    void load()
  }, [load])

  function save(event?: Event) {
    event?.preventDefault()
    if (!course) return
    void run(async () => {
      const saved = await apiJson<{ course: Course }>(`/api/courses/${encodeURIComponent(id)}`, 'PUT', {
        slug: course.slug,
        title: course.title,
        status: course.status,
        summary: course.summary,
        instructorName: course.instructorName,
        level: course.level,
        language: course.language,
      })
      setCourse(saved.course)
    }, '課程已儲存。')
  }

  async function publish() {
    setProblems([])
    try {
      const published = await apiJson<{ course: Course }>(
        `/api/courses/${encodeURIComponent(id)}/publish`,
        'POST',
        {},
      )
      setCourse(published.course)
    } catch (error) {
      // A 409 here is not a failure to report as one: it is the list of what
      // is left to do, which is the most useful thing this screen can say.
      if (error instanceof ApiError && error.status === 409) {
        const listed = error.body.problems
        setProblems(Array.isArray(listed) ? (listed as CoursePublishProblem[]) : [])
        return
      }
      showError(error)
    }
  }

  if (course === null) {
    return (
      <AdminShell current="/courses" back={{ href: '/courses', label: '回到課程列表' }} message={message} onError={showError}>
        <Panel title="課程">
          <Spinner />
        </Panel>
      </AdminShell>
    )
  }

  return (
    <AdminShell
      current="/courses"
      title={course.title}
      back={{ href: '/courses', label: '回到課程列表' }}
      message={message}
      onError={showError}
      actions={
        <>
          <Badge tone={STATUS_TONES[course.status]}>{STATUS_LABELS[course.status]}</Badge>
          <Button size="sm" busy={busy} onClick={() => void publish()}>
            發布
          </Button>
          <Button type="submit" form="course-form" size="sm" tone="primary" busy={busy}>
            儲存
          </Button>
        </>
      }
    >
      {problems.length > 0 && (
        <Panel title="還不能發布">
          <ul class="course-publish-problems">
            {/* Keyed by position: three unfinished videos produce three
                problems that all say `video`. */}
            {problems.map((problem, index) => (
              <li key={`${problem.field}-${index}`}>{problem.message}</li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="課程資料">
        <form id="course-form" class="ui-inline-form" onSubmit={save}>
          <TextField
            label="課程名稱"
            value={course.title}
            maxLength={120}
            required
            onInput={(event) => setCourse({ ...course, title: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="網址代稱"
            value={course.slug}
            maxLength={64}
            required
            onInput={(event) => setCourse({ ...course, slug: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="課程簡介"
            hint="商品頁會用它開頭"
            value={course.summary}
            maxLength={300}
            onInput={(event) => setCourse({ ...course, summary: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="講師"
            value={course.instructorName}
            maxLength={60}
            onInput={(event) =>
              setCourse({ ...course, instructorName: (event.currentTarget as HTMLInputElement).value })
            }
          />
          <Select
            label="難度"
            value={course.level}
            options={(Object.keys(LEVEL_LABELS) as CourseLevel[]).map((level) => ({
              value: level,
              label: LEVEL_LABELS[level],
            }))}
            onChange={(value) => setCourse({ ...course, level: value as CourseLevel })}
          />
        </form>
      </Panel>

      <Panel title="課程大綱">
        {sections.length === 0 ? (
          <EmptyState title="還沒有章節" body="課程至少要有一個章節與一個單元才能發布。" compact />
        ) : (
          <ol class="course-outline">
            {sections.map((section) => (
              <li key={section.id ?? section.position}>
                <p class="course-section-title">{section.title}</p>
                <ul class="course-lessons">
                  {section.lessons.map((lesson) => (
                    <li key={lesson.id ?? lesson.position}>
                      <span class="course-lesson-title">{lesson.title}</span>
                      {/* A reading is a valid lesson. Saying "no video" would
                          read as something missing rather than something
                          deliberate. */}
                      <span class="muted">{lesson.videoAssetId ? '影片單元' : '文字單元'}</span>
                      {lesson.isPreview && <Badge tone="info">試看</Badge>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </AdminShell>
  )
}
