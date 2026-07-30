import { describe, expect, it } from 'vitest'

import { aVideoAsset } from '../../shared/testing/fixtures'
import { canAbort, canArchive, runtime, videoFailure, videoStatusLabel } from './videoFacts'

describe('runtime', () => {
  it('reads as minutes and seconds', () => {
    expect(runtime(754)).toBe('12:34')
  })

  it('pads the seconds, because 12:4 is not a time', () => {
    expect(runtime(724)).toBe('12:04')
  })

  it('says an hour is an hour rather than seventy-five minutes', () => {
    /** The picker used to say 75:30. A course lesson can be that long, and a
     *  reader has to do arithmetic to find out whether it is. */
    expect(runtime(4530)).toBe('1:15:30')
  })

  it('says nothing when there is no readable duration', () => {
    /** ffprobe not reading a duration is a normal answer for an odd file, and
     *  "0:00" is a claim that the video is empty. */
    expect(runtime(null)).toBe('')
  })
})

describe('videoStatusLabel', () => {
  it('has a label for every state the pipeline can be in', () => {
    const statuses = [
      'uploading',
      'uploaded',
      'queued',
      'processing',
      'ready',
      'failed',
      'aborted',
      'archived',
    ] as const

    for (const status of statuses) expect(videoStatusLabel(status)).not.toBe('')
  })
})

describe('videoFailure', () => {
  it('says what went wrong', () => {
    const asset = aVideoAsset({ status: 'failed', errorCode: 'transcode', errorDetail: 'ffmpeg 退出碼 1' })

    expect(videoFailure(asset)).toBe('ffmpeg 退出碼 1（transcode）')
  })

  it('names the code when that is all there is', () => {
    const asset = aVideoAsset({ status: 'failed', errorCode: 'verify_missing_objects', errorDetail: null })

    expect(videoFailure(asset)).toContain('verify_missing_objects')
  })

  it('admits a failure recorded no reason rather than showing a blank', () => {
    /** An empty cell beside a red badge reads as a page fault. Saying the reason
     *  was not recorded is both true and actionable — it points at the upload log
     *  rather than at this screen. */
    const asset = aVideoAsset({ status: 'failed', errorCode: null, errorDetail: null })

    expect(videoFailure(asset)).not.toBe('')
  })

  it('has nothing to explain about a video that has not failed', () => {
    expect(videoFailure(aVideoAsset({ status: 'ready' }))).toBe('')
  })

  it('does not show a stale error on a working video', () => {
    /** Reaching `ready` clears the recorded error server-side, but a row read
     *  mid-retry can still carry one, and "ready, and here is why it failed" is
     *  a screen nobody can act on. */
    const asset = aVideoAsset({ status: 'ready', errorCode: 'transcode', errorDetail: '舊的失敗' })

    expect(videoFailure(asset)).toBe('')
  })
})

describe('canAbort', () => {
  it('offers the exit an unfinished upload otherwise does not have', () => {
    for (const status of ['uploading', 'uploaded', 'queued'] as const) {
      expect(canAbort(aVideoAsset({ status }))).toBe(true)
    }
  })

  it('is not offered for a video that became something', () => {
    /** `ready` and `failed` are archived, not abandoned, and `aborted`/`archived`
     *  are already over. */
    for (const status of ['ready', 'failed', 'aborted', 'archived'] as const) {
      expect(canAbort(aVideoAsset({ status }))).toBe(false)
    }
  })

  it('is not offered while a transcode is running', () => {
    /** `processing -> aborted` is not in the server's state table at all, so the
     *  button would be a 409. That gap is recorded in task.md rather than papered
     *  over here. */
    expect(canAbort(aVideoAsset({ status: 'processing' }))).toBe(false)
  })
})

describe('canArchive', () => {
  it('offers the move the state machine allows', () => {
    /** `backend/src/domain/video.py` TRANSITIONS: only `ready` and `failed` have
     *  an edge to `archived`. */
    expect(canArchive(aVideoAsset({ status: 'ready' }))).toBe(true)
    expect(canArchive(aVideoAsset({ status: 'failed' }))).toBe(true)
  })

  it('does not offer one the server would refuse', () => {
    for (const status of ['uploading', 'uploaded', 'queued', 'processing', 'aborted', 'archived'] as const) {
      expect(canArchive(aVideoAsset({ status }))).toBe(false)
    }
  })
})
