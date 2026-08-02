import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { MediaPicker } from '../components/MediaPicker'
import { RichTextEditor } from '../components/RichTextEditor'
import { useStatus } from '../components/StatusBar'
import { Badge, Button, Panel, Select, Spinner, TextField } from '../components/ui'
import type { BadgeTone } from '../components/ui'
import { CourseOutlineEditor } from '../features/catalogue/CourseOutlineEditor'
import { ApiError, api, apiJson, apiUrl } from '../../shared/api'
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

/** The long-form fields, in the order somebody deciding to buy reads them. */
const PROSE_FIELDS: { key: keyof Course & `${string}Html`; label: string; hint?: string }[] = [
  { key: 'outcomesHtml', label: '你將學會', hint: '商品頁會放在最前面' },
  { key: 'audienceHtml', label: '適合對象' },
  { key: 'descriptionHtml', label: '課程介紹' },
  { key: 'prerequisitesHtml', label: '先備知識' },
  { key: 'materialsHtml', label: '需要準備的工具或材料' },
  { key: 'instructorBioHtml', label: '講師介紹' },
]

/**
 * Writing a course.
 *
 * Publishing shows every reason it cannot rather than the first: an author who
 * fixes one thing per attempt, and only then learns about the next, gives up
 * somewhere around the third.
 *
 * The outline is held as a draft here and saved with the rest, because the
 * server replaces it as a whole. Saving each row as it changed would leave an
 * outline half-updated on any failed request, and half a course is worse than
 * an unsaved one.
 */
export function CourseEditPage({ id }: { id: string }) {
  const [course, setCourse] = useState<Course | null>(null)
  const [sections, setSections] = useState<CourseSection[]>([])
  const [problems, setProblems] = useState<CoursePublishProblem[]>([])
  const [dirty, setDirty] = useState(false)
  const [pickingCover, setPickingCover] = useState(false)
  const { message, showError, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      const [detail, outline] = await Promise.all([
        api<{ course: Course }>(`/api/courses/${encodeURIComponent(id)}`),
        api<{ sections: CourseSection[] }>(`/api/courses/${encodeURIComponent(id)}/outline`),
      ])
      setCourse(detail.course)
      setSections(outline.sections)
      setDirty(false)
    } catch (error) {
      showError(error)
    }
  }, [id, showError])

  useEffect(() => {
    void load()
  }, [load])

  function edit(patch: Partial<Course>) {
    setCourse((current) => (current ? { ...current, ...patch } : current))
    setDirty(true)
  }

  function editOutline(next: CourseSection[]) {
    setSections(next)
    setDirty(true)
  }

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
        coverMediaId: course.coverMediaId,
        descriptionHtml: course.descriptionHtml,
        instructorBioHtml: course.instructorBioHtml,
        audienceHtml: course.audienceHtml,
        outcomesHtml: course.outcomesHtml,
        prerequisitesHtml: course.prerequisitesHtml,
        materialsHtml: course.materialsHtml,
      })
      // The outline goes as one tree. The server replaces it, so a partial
      // send would be a partial course.
      const outline = await apiJson<{ sections: CourseSection[] }>(
        `/api/courses/${encodeURIComponent(id)}/outline`,
        'PUT',
        { sections },
      )
      setCourse(saved.course)
      setSections(outline.sections)
      setDirty(false)
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
      // A 409 here is not a failure to report as one: it is the list of what is
      // left to do, which is the most useful thing this screen can say.
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
      // Leaving with unsaved work loses the whole outline, not one field.
      confirmLeave={() => !dirty || confirm('有未儲存的修改，確定要離開嗎？')}
      actions={
        <>
          <Badge tone={STATUS_TONES[course.status]}>{STATUS_LABELS[course.status]}</Badge>
          {dirty && <span class="muted">未儲存</span>}
          <Button size="sm" busy={busy} onClick={() => void publish()}>
            發布
          </Button>
          <Button type="submit" form="course-form" size="sm" tone="primary" busy={busy} disabled={!dirty}>
            儲存
          </Button>
        </>
      }
    >
      {problems.length > 0 && (
        <Panel title="還不能發布">
          <ul class="course-publish-problems">
            {/* Keyed by position: three unfinished videos produce three problems
                that all say `video`. */}
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
            onInput={(event) => edit({ title: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="網址代稱"
            value={course.slug}
            maxLength={64}
            required
            onInput={(event) => edit({ slug: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="課程簡介"
            hint="商品頁會用它開頭"
            value={course.summary}
            maxLength={300}
            onInput={(event) => edit({ summary: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="講師"
            value={course.instructorName}
            maxLength={60}
            onInput={(event) => edit({ instructorName: (event.currentTarget as HTMLInputElement).value })}
          />
          <Select
            label="難度"
            value={course.level}
            options={(Object.keys(LEVEL_LABELS) as CourseLevel[]).map((level) => ({
              value: level,
              label: LEVEL_LABELS[level],
            }))}
            onChange={(value) => edit({ level: value as CourseLevel })}
          />
        </form>
      </Panel>

      <Panel title="課程封面">
        {course.coverMediaId && course.coverPath ? (
          <div class="course-cover">
            {/* The path, not the id. The id is what the picker sets and the form
                saves; the URL is built from the object key, which only the media
                library knows — building it here drew a broken image on every
                course that had a cover. */}
            <img src={apiUrl(course.coverPath)} alt="" />
            <Button size="sm" onClick={() => setPickingCover(true)}>
              更換
            </Button>
            <Button size="sm" tone="ghost" onClick={() => edit({ coverMediaId: null, coverPath: null })}>
              移除
            </Button>
          </div>
        ) : (
          <>
            <p class="muted">發布前需要一張封面，商品頁與「我的課程」都會用它。</p>
            <Button size="sm" onClick={() => setPickingCover(true)}>
              選擇封面
            </Button>
          </>
        )}
        <MediaPicker
          open={pickingCover}
          selectedId={course.coverMediaId}
          onPick={(item) => {
            // Both, so the preview is the picture just chosen rather than
            // whatever the last save resolved.
            edit({ coverMediaId: item.id, coverPath: item.path })
            setPickingCover(false)
          }}
          onClose={() => setPickingCover(false)}
        />
      </Panel>

      {PROSE_FIELDS.map((field) => (
        <Panel title={field.label} key={field.key}>
          {field.hint && <p class="muted">{field.hint}</p>}
          {/* The editor limits what an author can type; the server cleans what
              arrives, whichever route it came by. */}
          <RichTextEditor
            config={{ body: (course[field.key] as string) ?? '', format: 'html' }}
            onChange={(next) => edit({ [field.key]: next.body } as Partial<Course>)}
          />
        </Panel>
      ))}

      <Panel title="課程大綱">
        <CourseOutlineEditor sections={sections} onChange={editOutline} />
      </Panel>
    </AdminShell>
  )
}
