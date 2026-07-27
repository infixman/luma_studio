import { describe, expect, it } from 'vitest'

import { eventDate, eventTime } from './calendar'
import type { BioLinkEvent } from '../../shared/types'

function makeEvent(overrides: Partial<BioLinkEvent> = {}): BioLinkEvent {
  return {
    id: 'abc@google.com-20260808T100000',
    title: '兒童美術 · 週六班',
    start: '2026-08-08T10:00:00+08:00',
    end: '2026-08-08T12:00:00+08:00',
    allDay: false,
    location: '台中市西區',
    description: '',
    ...overrides,
  }
}

describe('showing when a class is', () => {
  it('formats the date in Taipei time', () => {
    expect(eventDate('2026-08-08T10:00:00+08:00')).toEqual({ day: '8', month: '8月', weekday: '週六' })
  })

  it('reads the same for someone abroad', () => {
    // The class is in Taipei whoever is looking at the page. Formatting in
    // the reader's own zone would advertise the wrong hour.
    const utcForm = eventDate('2026-08-08T02:00:00Z')
    expect(utcForm).toEqual({ day: '8', month: '8月', weekday: '週六' })
  })

  it('shows a time range', () => {
    expect(eventTime(makeEvent())).toBe('10:00–12:00')
  })

  it('shows a single time when the event has no length', () => {
    expect(eventTime(makeEvent({ end: '2026-08-08T10:00:00+08:00' }))).toBe('10:00')
  })

  it('says all day rather than 00:00', () => {
    expect(eventTime(makeEvent({ allDay: true }))).toBe('全天')
  })

  it('keeps a late class on its own evening', () => {
    // 23:30 in Taipei is the previous afternoon in UTC; the date shown must
    // follow the class, not the timestamp's UTC day.
    expect(eventDate('2026-08-08T23:30:00+08:00').day).toBe('8')
  })
})
