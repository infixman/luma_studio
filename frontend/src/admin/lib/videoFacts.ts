/**
 * What the back office says about a course video, in words.
 *
 * Apart from the screens that draw them because three of them describe the same
 * asset: the library lists it, the outline editor offers it to a lesson, and the
 * archive prompt names it. The moment two of those call one video something
 * different, the admin is looking for a video the system calls another name.
 */

import type { BadgeTone } from '../components/ui'
import type { VideoAsset, VideoAssetStatus } from '../../shared/types'

/**
 * The eight states, in the admin's language rather than the pipeline's.
 *
 * Written as a full record rather than a lookup with a fallback: a status this
 * does not cover should fail to compile, not render as a blank cell. The
 * distinctions matter — "轉檔中" is a wait, "已放棄" is over, and an admin
 * deciding whether to re-upload needs to know which one they are looking at.
 */
const STATUS_LABELS: Record<VideoAssetStatus, string> = {
  uploading: '上傳中',
  uploaded: '已上傳',
  queued: '等待轉檔',
  processing: '轉檔中',
  ready: '可播放',
  failed: '轉檔失敗',
  aborted: '已放棄',
  archived: '已封存',
}

const STATUS_TONES: Record<VideoAssetStatus, BadgeTone> = {
  uploading: 'neutral',
  uploaded: 'neutral',
  queued: 'neutral',
  processing: 'warning',
  ready: 'success',
  failed: 'danger',
  aborted: 'neutral',
  archived: 'neutral',
}

export function videoStatusLabel(status: VideoAssetStatus): string {
  return STATUS_LABELS[status]
}

export function videoStatusTone(status: VideoAssetStatus): BadgeTone {
  return STATUS_TONES[status]
}

/**
 * A duration, as a time.
 *
 * Hours are split out. The picker used to say `75:30`, which is a valid reading
 * of a number of minutes and a poor way to learn that a lesson is over an hour.
 *
 * No duration is a normal answer — ffprobe does not always find one — and it
 * comes back as nothing rather than `0:00`, which would be a claim that the
 * video is empty.
 */
export function runtime(durationSeconds: number | null): string {
  if (durationSeconds === null || durationSeconds < 0) return ''
  const hours = Math.floor(durationSeconds / 3600)
  const minutes = Math.floor((durationSeconds % 3600) / 60)
  const seconds = Math.floor(durationSeconds % 60)
  const padded = String(seconds).padStart(2, '0')
  if (hours === 0) return `${minutes}:${padded}`
  return `${hours}:${String(minutes).padStart(2, '0')}:${padded}`
}

/**
 * Whether retiring this video is a move the pipeline makes.
 *
 * A copy of the server's state table, and deliberately a small one: only
 * `ready` and `failed` lead to `archived`. The server refuses the rest with a
 * 409, so this is not the check that protects anything — it decides whether to
 * offer a button whose only possible outcome is an error. An action that cannot
 * work reads as a fault in the system rather than a rule of it.
 *
 * An upload that stalled is the case this leaves without an exit, and it needs
 * one: `uploading -> aborted` exists in the state machine with no endpoint
 * behind it. `uploaded` and `queued` are in the same position, and `processing`
 * cannot reach `aborted` at all — a transcode that died leaves a row nothing
 * can retire.
 */
export function canArchive(asset: VideoAsset): boolean {
  return asset.status === 'ready' || asset.status === 'failed'
}

/**
 * Whether this upload can be abandoned.
 *
 * The other half of the same table: `uploading`, `uploaded` and `queued` reach
 * `aborted`. `processing` does not — a transcode that died leaves a row nothing
 * can retire, which is recorded in task.md rather than papered over with a
 * button that 409s.
 */
export function canAbort(asset: VideoAsset): boolean {
  return asset.status === 'uploading' || asset.status === 'uploaded' || asset.status === 'queued'
}

/**
 * Whether this row can still change without anybody pressing anything.
 *
 * The four states the pipeline is still moving through. Everything else has
 * arrived somewhere it stays until a person acts, which is what makes it safe
 * for the library to stop polling — a request every three seconds for ever,
 * whose answer can only be identical, is not a refresh but a leak.
 */
export function stillMoving(asset: VideoAsset): boolean {
  return (
    asset.status === 'uploading' ||
    asset.status === 'uploaded' ||
    asset.status === 'queued' ||
    asset.status === 'processing'
  )
}

/**
 * Whether there is anything to watch.
 *
 * Beside `canArchive` for the same reason it exists: the server answers 409
 * when there is no active encode, so offering the action would produce nothing
 * but an error. An archived asset keeps its version and is deliberately still
 * previewable — being able to look at what was retired is the point of keeping
 * the objects around until the sweep takes them.
 */
export function canPreview(asset: VideoAsset): boolean {
  return asset.encodeVersion !== null
}

/**
 * Why this video will not play, if that is where it is.
 *
 * Only for a failed asset. Reaching `ready` clears the recorded error on the
 * server, but a row read while a retry is in flight can still carry one, and
 * "playable, and here is why it failed" is a line nobody can act on.
 *
 * A failure with nothing recorded says so rather than rendering an empty cell
 * beside a red badge — which reads as a fault in this page. Naming the code when
 * there is no detail is worth it too: `verify_missing_objects` is not prose, but
 * it is the difference between "upload again" and "look at the transcode log".
 */
export function videoFailure(asset: VideoAsset): string {
  if (asset.status !== 'failed') return ''
  const detail = (asset.errorDetail ?? '').trim()
  const code = (asset.errorCode ?? '').trim()
  if (detail && code) return `${detail}（${code}）`
  if (detail) return detail
  if (code) return code
  return '沒有留下失敗原因，請看上傳工具當時的訊息'
}
