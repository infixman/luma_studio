import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Panel,
  Spinner,
  TextField,
} from '../components/ui'
import type { BadgeTone, Column } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import { slugifyAscii } from '../lib/slug'
import type { Course, CourseStatus } from '../../shared/types'
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

const EMPTY_DRAFT = { title: '', slug: '' }

/**
 * Courses as things an offer can point at.
 *
 * Phase 2 holds the identity only — a name, a URL segment and a status. The
 * editor with sections, lessons and video is phase 5, so nothing here should
 * grow a second copy of what that screen will own.
 *
 * The status is what matters now: an offer granting a draft course sells
 * access to nothing, so the product editor refuses to enable it and says so.
 */
export function CoursesPage() {
  const [courses, setCourses] = useState<Course[] | null>(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const { message, showError, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      setCourses((await api<{ courses: Course[] }>('/api/courses')).courses)
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  async function create(event: Event) {
    event.preventDefault()
    const ok = await run(async () => {
      await apiJson<{ course: Course }>('/api/courses', 'POST', {
        title: draft.title.trim(),
        slug: draft.slug.trim() || slugifyAscii(draft.title, 64),
        status: 'draft',
      })
    }, '課程已建立。')

    if (ok) {
      setDraft(EMPTY_DRAFT)
      await load()
    }
  }

  const columns: Column<Course>[] = [
    {
      key: 'title',
      label: '課程名稱',
      render: (course) => (
        <a href={`/courses/${encodeURIComponent(course.id)}`}>{course.title}</a>
      ),
    },
    { key: 'slug', label: '網址代稱', render: (course) => course.slug },
    {
      key: 'status',
      label: '狀態',
      render: (course) => <Badge tone={STATUS_TONES[course.status]}>{STATUS_LABELS[course.status]}</Badge>,
    },
  ]

  return (
    <AdminShell current="/courses" message={message} onError={showError}>
      <Panel title="線上課程">
        <p class="muted">
          課程只負責「教什麼」，售價與方案在商品那邊設定。課程要先發布，包含它的銷售方案才能上架。
        </p>

        {courses === null ? (
          <Spinner />
        ) : (
          <DataTable
            rows={courses}
            columns={columns}
            rowKey={(course) => course.id}
            empty={
              <EmptyState
                title="還沒有課程"
                body="建立第一門課程，之後就能把它加進商品的銷售方案裡。"
              />
            }
          />
        )}
      </Panel>

      <Panel title="新增課程">
        <form class="ui-inline-form" onSubmit={create}>
          <TextField
            label="課程名稱"
            value={draft.title}
            maxLength={120}
            required
            onInput={(event) => setDraft({ ...draft, title: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="網址代稱"
            hint="留空會依名稱自動產生"
            value={draft.slug}
            maxLength={64}
            onInput={(event) => setDraft({ ...draft, slug: (event.currentTarget as HTMLInputElement).value })}
          />
          <Button type="submit" tone="primary" busy={busy} disabled={draft.title.trim() === ''}>
            新增
          </Button>
        </form>
      </Panel>
    </AdminShell>
  )
}
