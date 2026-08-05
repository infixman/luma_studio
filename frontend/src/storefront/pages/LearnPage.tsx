import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { LessonPlayer } from '../components/LessonPlayer'
import { api, apiJson, apiUrl } from '../../shared/api'
import { renewDelay, requestSession, shouldSaveProgress, worthRetrying } from '../lib/playback'
import { inOrder } from '../lib/lessons'
import type { LearnCourse, PlaybackRefusal } from '../../shared/types'
import '../styles/shop.css'

/** How long to leave a "still encoding" lesson before trying again. */
const RETRY_SECONDS = 20

/**
 * Whether the end of a lesson runs on into the next one.
 *
 * Remembered, unlike theatre mode and playback speed: those are about one
 * sitting, this is about how somebody watches a course, and being carried
 * into the next lesson when you did not want to be is the kind of thing you
 * turn off once and expect to stay off.
 *
 * On by default. A course is an ordered thing somebody sits through, and
 * stopping dead at the end of every lesson to reach for the mouse is the
 * behaviour that needs the excuse.
 */
const AUTOPLAY_KEY = 'luma.learn.autoplay'

function rememberedAutoplay(): boolean {
  try {
    return localStorage.getItem(AUTOPLAY_KEY) !== 'off'
  } catch {
    // Private windows and blocked storage: the default is a working default.
    return true
  }
}

/**
 * Watching one lesson.
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
 *
 * Which lesson is in the address, so a lesson can be linked to and the back
 * button means what it looks like. It is still held in state as well: moving
 * to the next one rewrites the address rather than reloading the page, because
 * the course is already here and fetching it again to draw the same header
 * would put a blank screen between two lessons.
 */
export function LearnPage({ slug, lessonId: opened }: { slug: string; lessonId: string }) {
  const [course, setCourse] = useState<LearnCourse | null>(null)
  const [lessonId, setLessonId] = useState<string | null>(opened)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<{ reason: PlaybackRefusal | 'unknown'; message: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const [theater, setTheater] = useState(false)
  const [autoplay, setAutoplay] = useState(rememberedAutoplay)

  const chooseAutoplay = useCallback((next: boolean) => {
    setAutoplay(next)
    try {
      localStorage.setItem(AUTOPLAY_KEY, next ? 'on' : 'off')
    } catch {
      // Nothing to do about it, and nothing worth stopping for: the choice
      // still holds for this sitting.
    }
  }, [])
  const renewal = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<number | null>(null)

  useEffect(() => {
    api<LearnCourse>(`/api/learning/courses/${encodeURIComponent(slug)}`)
      .then((data) => {
        setCourse(data)
        // A lesson id that is not in this course — an old link, or an outline
        // that has been rewritten since — falls back to the start rather than
        // to an error. There is a course here and it is theirs.
        const lessons = inOrder(data)
        if (!lessons.some((lesson) => lesson.id === opened)) {
          const first = lessons[0]
          setLessonId(first ? first.id : null)
        }
      })
      .catch(() => setFailed(true))
  }, [slug, opened])

  useEffect(() => {
    const lesson = course && inOrder(course).find((entry) => entry.id === lessonId)
    document.title = lesson ? `${lesson.title} | Luma Studio` : '課程 | Luma Studio'
  }, [course, lessonId])

  /** The address follows the lesson, so linking and the back button both work. */
  const show = useCallback(
    (id: string) => {
      setLessonId(id)
      history.replaceState(null, '', `/learn/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`)
    },
    [slug],
  )

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

  const record = useCallback(
    (seconds: number, completed: boolean) => {
      if (lessonId === null) return
      if (!completed && !shouldSaveProgress(seconds, lastSaved.current)) return
      lastSaved.current = seconds
      // Deliberately unawaited and deliberately swallowed. A dropped progress
      // write costs somebody twenty seconds of rewinding; an error banner over
      // a playing video costs them the lesson.
      void apiJson(`/api/learning/lessons/${encodeURIComponent(lessonId)}/progress`, 'PUT', {
        positionSeconds: seconds,
        completed,
      }).catch(() => {})
    },
    [lessonId],
  )

  useEffect(() => {
    if (lessonId === null) return
    lastSaved.current = null
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

  const lessons = inOrder(course)
  const index = lessons.findIndex((lesson) => lesson.id === lessonId)
  const current = index >= 0 ? lessons[index]! : null
  // Across chapters, not within one: to somebody watching, the course is one
  // sequence and a chapter boundary is not a wall.
  const previous = index > 0 ? lessons[index - 1]! : null
  const next = index >= 0 && index < lessons.length - 1 ? lessons[index + 1]! : null

  const courseHref = `/learn/${encodeURIComponent(course.slug)}`

  return (
    <main class="shop learn">
      {/* The course title is a way back rather than a heading. What this page
          is showing is the lesson, and printing both as headings was the same
          two lines the contents beside them already said. */}
      <p class="crumb">
        <a href={courseHref}>← {course.title}</a>
      </p>

      <div class={`learn-layout${theater ? ' is-theater' : ''}`}>
        <section class="learn-stage">
          {current === null ? (
            <p class="note">這門課程還沒有單元。</p>
          ) : (
            <>
              <h1>{current.title}</h1>
              {lessons.length > 1 && (
                <p class="note learn-place">
                  第 {index + 1} / {lessons.length} 單元
                </p>
              )}

              {refusal && <p class="note">{refusal.message}</p>}

              {playbackUrl && (
                <LessonPlayer
                  src={apiUrl(playbackUrl)}
                  onPosition={(seconds) => record(seconds, false)}
                  onEnded={() => {
                    record(Math.max(1, lastSaved.current ?? 1), true)
                    // Marked finished either way; moving on is the extra.
                    if (autoplay && next) show(next.id)
                  }}
                  autoplay={autoplay}
                  onAutoplayChange={chooseAutoplay}
                  onError={() => setRefusal({ reason: 'unknown', message: '影片載入失敗，請重新整理再試。' })}
                  onTheaterChange={setTheater}
                />
              )}

              {!current.hasVideo && <p class="note">這是文字單元。</p>}

              {/* Already sanitised on the server; the editor's own limits are
                  a convenience rather than the boundary. */}
              <div class="learn-content" dangerouslySetInnerHTML={{ __html: current.contentHtml }} />

              <div class="learn-actions">
                <button type="button" disabled={previous === null} onClick={() => previous && show(previous.id)}>
                  上一單元
                </button>
                {/* A reading has no `ended` to fire, so finishing it is a
                    thing the member says rather than something observed. */}
                <button type="button" onClick={() => record(Math.max(1, lastSaved.current ?? 1), true)}>
                  標記完成
                </button>
                <button type="button" disabled={next === null} onClick={() => next && show(next.id)}>
                  下一單元
                </button>
                {/* The way back to everything else. The contents used to be a
                    column on this page; they are a page of their own now, and
                    this is the door to it. */}
                <a class="learn-contents" href={courseHref}>
                  課程目錄
                </a>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}
