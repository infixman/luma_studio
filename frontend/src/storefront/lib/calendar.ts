/** Date and time formatting for the schedule section. */

import type { BioLinkEvent } from '../../shared/types'

/**
 * Classes happen in Taipei, so they are shown in Taipei time whoever is
 * reading. Formatting in the viewer's own zone would tell someone abroad a
 * class starts at an hour it does not.
 */
const ZONE = 'Asia/Taipei'

// A bare number for the badge: zh-TW renders `day` as "8日", which reads
// wrong stacked above the month.
const dayFormat = new Intl.DateTimeFormat('en', { timeZone: ZONE, day: 'numeric' })
const monthFormat = new Intl.DateTimeFormat('zh-TW', { timeZone: ZONE, month: 'short' })
const weekdayFormat = new Intl.DateTimeFormat('zh-TW', { timeZone: ZONE, weekday: 'short' })
const timeFormat = new Intl.DateTimeFormat('zh-TW', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false })

export interface EventDate {
  day: string
  month: string
  weekday: string
}

export function eventDate(iso: string): EventDate {
  const moment = new Date(iso)
  return {
    day: dayFormat.format(moment),
    month: monthFormat.format(moment),
    weekday: weekdayFormat.format(moment),
  }
}

export function eventTime(event: BioLinkEvent): string {
  if (event.allDay) return '全天'
  const start = timeFormat.format(new Date(event.start))
  const end = timeFormat.format(new Date(event.end))
  return start === end ? start : `${start}–${end}`
}
