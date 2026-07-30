/**
 * The name a resumed upload finds its ledger under.
 *
 * Two opposite mistakes are possible and both are silent. Too eager and a
 * re-encode resumes against the previous asset, uploading none of the files that
 * changed — the video is quietly the old one. Too strict and the same folder
 * uploads itself again under a new asset id, which is how a verification run
 * produced two assets and twenty-eight objects for one video.
 */

import { expect, test } from 'vitest'

import { jobId } from './resume'

const FOLDER = String.raw`C:\Users\a\AppData\Roaming\luma-video-uploader\encodes\lesson-1`

test('the same folder and contents give the same name', () => {
  expect(jobId(FOLDER, 14, 5_000)).toBe(jobId(FOLDER, 14, 5_000))
})

test('separators do not change it', () => {
  /** `C:\encodes\a` and `C:/encodes/a` are one folder on Windows. They were two
   *  ledgers, and the second one created a second asset. */
  expect(jobId(FOLDER.replace(/\\/g, '/'), 14, 5_000)).toBe(jobId(FOLDER, 14, 5_000))
})

test('nor does case', () => {
  /** Windows paths are case-insensitive, and a path that came from a drop and one
   *  typed by hand differ in exactly this way. */
  expect(jobId(FOLDER.toUpperCase(), 14, 5_000)).toBe(jobId(FOLDER, 14, 5_000))
})

test('a different folder is a different job', () => {
  expect(jobId(`${FOLDER}-2`, 14, 5_000)).not.toBe(jobId(FOLDER, 14, 5_000))
})

test('re-encoding into the same folder is a different job', () => {
  /** The relative paths are identical after a re-encode, so a ledger keyed on the
   *  path alone would skip every file that changed. */
  expect(jobId(FOLDER, 14, 5_001)).not.toBe(jobId(FOLDER, 14, 5_000))
  expect(jobId(FOLDER, 15, 5_000)).not.toBe(jobId(FOLDER, 14, 5_000))
})

test('the fields cannot run into each other', () => {
  /** Concatenated without a separator, `("a1", 4)` and `("a", 14)` would be the
   *  same string. */
  expect(jobId('a1', 4, 1)).not.toBe(jobId('a', 14, 1))
})

test('it is short enough to be a filename', () => {
  expect(jobId(FOLDER, 14, 5_000)).toMatch(/^[0-9a-f]{16}$/)
})
