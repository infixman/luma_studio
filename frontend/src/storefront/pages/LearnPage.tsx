import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { api } from '../../shared/api'
import { renewDelay, requestSession, worthRetrying } from '../lib/playback'
import type { PlaybackRefusal } from '../../shared/types'
import '../styles/shop.css'

interface LearnLesson {
  id: string
  title: string
  contentHtml: string
  hasVideo: boolean
  isPreview: boolean
  completed: boolean
}

interface LearnSection {
  title: string
  lessons: LearnLesson[]
}

interface LearnCourse {
  title: string
  sections: LearnSection[]
}

/** How long to leave a "still encoding" lesson before trying again. */
const RETRY_SECONDS = 20

/**
 * Watching a course.
 *
 * The player is pointed at a gateway URL and the permission travels as a
 * cookie the page never sees. Two consequences shape this component: the URL
 * alone is useless to anybody else, and the permission lapses, so the session
 * is renewed before it does rather than after a segment has already been
 * refused.
 *
 * A refusal is not retried unless it can change on its own. "Still encoding"
 * becomes ready; "you have not bought this" does not, and asking again is
 * asking the same question louder.
 */
export function LearnPage({ slug }: { slug: string }) {
  const [course, setCourse] = useState<LearnCourse | null>(null)
  const [lessonId, setLessonId] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ reason: PlaybackRefusal | 'unknown'; message: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const renewal = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    document.title = '課程 | Luma Studio'
    api<LearnCourse>(`/api/learning/courses/${encodeURIComponent(slug)}`)
      .then((data) => {
        setCourse(data)
        const first = data.sections.flatMap((section) => section.lessons)[0]
        if (first) setLessonId(first.id)
      })
      .catch(() => setFailed(true))
  }, [slug])

  const open = useCallback(async (id: string) => {
    if (renewal.current) clearTimeout(renewal.current)
    setPlaybackUrl(null)
    setRefusal(null)

    const result = await requestSession(id)
    if (!result.ok) {
      setRefusal({ reason: result.reason, message: result.message })
      // Only the one refusal that fixes itself is worth a timer.
      if (worthRetrying(result.reason)) {
        renewal.current = setTimeout(() => void open(id), RETRY_SECONDS * 1000)
      }
      return
    }

    setPlaybackUrl(result.playbackUrl)
    const wait = renewDelay(result.expiresAt, Math.floor(Date.now() / 1000))
    renewal.current = setTimeout(() => void open(id), wait * 1000)
  }, [])

  useEffect(() => {
    if (lessonId === null) return
    void open(lessonId)
    return () => {
      if (renewal.current) clearTimeout(renewal.current)
    }
  }, [lessonId, open])

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

  const lessons = course.sections.flatMap((section) => section.lessons)
  const current = lessons.find((lesson) => lesson.id === lessonId) ?? null

  return (
    <main class="shop learn">
      <h1>{course.title}</h1>

      <div class="learn-layout">
        <section class="learn-stage">
          {current === null ? (
            <p class="note">這門課程還沒有單元。</p>
          ) : (
            <>
              <h2>{current.title}</h2>

              {refusal && <p class="note">{refusal.message}</p>}

              {playbackUrl && (
                // `credentials` matters: the permission is a cookie on this
                // path, and a media element that does not send it gets a 403.
                <video class="learn-video" controls crossOrigin="use-credentials" src={playbackUrl} />
              )}

              {!current.hasVideo && <p class="note">這是文字單元。</p>}

              {/* Already sanitised on the server; the editor's own limits are
                  a convenience rather than the boundary. */}
              <div class="learn-content" dangerouslySetInnerHTML={{ __html: current.contentHtml }} />
            </>
          )}
        </section>

        <nav class="learn-outline" aria-label="課程大綱">
          {course.sections.map((section) => (
            <div key={section.title}>
              <h3>{section.title}</h3>
              <ul>
                {section.lessons.map((lesson) => (
                  <li key={lesson.id}>
                    <button
                      type="button"
                      class={lesson.id === lessonId ? 'is-current' : ''}
                      aria-current={lesson.id === lessonId ? 'true' : undefined}
                      onClick={() => setLessonId(lesson.id)}
                    >
                      {/* Not colour alone: a tick reads the same to somebody
                          who cannot tell the two greens apart. */}
                      <span aria-hidden="true">{lesson.completed ? '✓' : '○'}</span>
                      <span>{lesson.title}</span>
                      {lesson.completed && <span class="sr-only">（已完成）</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </main>
  )
}
