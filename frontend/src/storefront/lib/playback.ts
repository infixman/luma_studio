import { ApiError, apiJson } from '../../shared/api'
import type { PlaybackRefusal, PlaybackSession } from '../../shared/types'

/**
 * Asking for permission to play a lesson.
 *
 * The permission itself is a cookie the server sets, scoped to the media path
 * and HttpOnly — this module never sees it and neither does anything else in
 * the page. What comes back is only where to point the player and when the
 * permission lapses.
 */

/**
 * How early to renew.
 *
 * The session outlives this by minutes, so renewing here means a lesson never
 * stops mid-sentence to ask again. Renewing exactly at expiry would put the
 * request and the first refused segment in the same instant.
 */
export const RENEW_BEFORE_SECONDS = 120

export interface PlaybackRefused {
  ok: false
  reason: PlaybackRefusal | 'unknown'
  message: string
}

export type PlaybackResult = ({ ok: true } & PlaybackSession) | PlaybackRefused

export async function requestSession(lessonId: string): Promise<PlaybackResult> {
  try {
    const session = await apiJson<PlaybackSession>(
      `/api/learning/lessons/${encodeURIComponent(lessonId)}/playback-session`,
      'POST',
      {},
    )
    return { ok: true, ...session }
  } catch (error) {
    if (error instanceof ApiError) {
      const reason = error.body.reason
      return {
        ok: false,
        reason: typeof reason === 'string' ? (reason as PlaybackRefusal) : 'unknown',
        message: error.message,
      }
    }
    return { ok: false, reason: 'unknown', message: '目前無法播放，請稍後再試。' }
  }
}

/**
 * Whether a refusal is worth trying again.
 *
 * Only one is. "Still encoding" becomes ready on its own; the others are
 * statements about who this person is, and retrying them is asking the same
 * question louder.
 */
export function worthRetrying(reason: PlaybackRefused['reason']): boolean {
  return reason === 'not_ready'
}

/** Seconds to wait before renewing a session that expires at `expiresAt`. */
export function renewDelay(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - RENEW_BEFORE_SECONDS - now)
}

/**
 * How often to tell the server where somebody got to.
 *
 * A `timeupdate` fires several times a second. Writing on each would be a few
 * hundred database writes per lesson for information that is only ever read
 * once, when they come back.
 */
export const PROGRESS_INTERVAL_SECONDS = 20

/**
 * Whether this position is worth sending.
 *
 * Also true when the position went *backwards* by more than the interval:
 * somebody who scrubbed from the end to the middle has moved, and waiting
 * twenty seconds to record that would lose it if they closed the tab.
 */
export function shouldSaveProgress(seconds: number, lastSaved: number | null): boolean {
  if (lastSaved === null) return seconds > 0
  return Math.abs(seconds - lastSaved) >= PROGRESS_INTERVAL_SECONDS
}
