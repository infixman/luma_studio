import { eventDate, eventFileUrl, eventTime, googleCalendarUrl } from '../lib/calendar'
import type { BioLinkEvent } from '../lib/types'

function Event({ event }: { event: BioLinkEvent }) {
  const date = eventDate(event.start)
  return (
    <li class="bio-event">
      <div class="bio-event-date" aria-hidden="true">
        <span class="bio-event-month">{date.month}</span>
        <span class="bio-event-day">{date.day}</span>
        <span class="bio-event-weekday">{date.weekday}</span>
      </div>
      <div class="bio-event-body">
        <h3 class="bio-event-name">{event.title}</h3>
        <p class="bio-event-meta">
          {date.month}
          {date.day}日（{date.weekday}）{eventTime(event)}
          {event.location ? `・${event.location}` : ''}
        </p>
        {event.description && <p class="bio-event-note">{event.description}</p>}
        <div class="bio-event-actions">
          <a
            class="bio-event-action"
            href={googleCalendarUrl(event)}
            target="_blank"
            rel="noopener noreferrer"
          >
            加入 Google 行事曆
          </a>
          {/* Everything that is not Google: iPhone, Outlook, and the rest. */}
          <a class="bio-event-action" href={eventFileUrl(event)}>
            下載 .ics
          </a>
        </div>
      </div>
    </li>
  )
}

export function BioLinkCalendar({ calendar }: { calendar: { title: string; events: BioLinkEvent[] } }) {
  if (calendar.events.length === 0) return null
  return (
    <section class="bio-calendar" aria-labelledby="bio-calendar-title">
      <h2 class="bio-calendar-title" id="bio-calendar-title">
        {calendar.title}
      </h2>
      <ul class="bio-links">
        {calendar.events.map((event) => (
          <Event key={event.id} event={event} />
        ))}
      </ul>
    </section>
  )
}
