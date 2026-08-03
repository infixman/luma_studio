/**
 * Times on a control bar.
 *
 * Its own module because the rule is not obvious and is easy to get subtly
 * wrong: an hour has to appear only once there is one, since 00:02:55 on a
 * three-minute lesson reads as a mistake, and 2:55 on a two-hour recording
 * reads as a different video.
 */

import { expect, test } from 'vitest'

import { clock } from './clock'

test('a fresh video is at zero, not blank', () => {
  expect(clock(0)).toBe('0:00')
})

test('seconds are padded, minutes are not', () => {
  /** 0:7 is not a time. 07:12 is a time nobody writes. */
  expect(clock(7)).toBe('0:07')
  expect(clock(72)).toBe('1:12')
})

test('the hour appears only once there is one', () => {
  expect(clock(3599)).toBe('59:59')
  expect(clock(3600)).toBe('1:00:00')
  expect(clock(3723)).toBe('1:02:03')
})

test('a part-second is the second it is in, not the one after', () => {
  /** currentTime is a float and arrives mid-second. Rounding up shows a
   *  video ending at 2:56 when the bar says it is 2:55 long. */
  expect(clock(2.9)).toBe('0:02')
})

test('nothing known yet reads as nothing, not as zero', () => {
  /** duration is NaN until the metadata lands, and Infinity for a live
   *  stream. Both would render as 0:00 or NaN:NaN without this. */
  expect(clock(Number.NaN)).toBe('--:--')
  expect(clock(Number.POSITIVE_INFINITY)).toBe('--:--')
})

test('a negative time cannot happen and is not drawn as though it had', () => {
  expect(clock(-3)).toBe('0:00')
})
