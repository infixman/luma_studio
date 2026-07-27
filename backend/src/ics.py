"""Just enough iCalendar to show a class schedule.

Google exports recurring events as a rule, not as occurrences, so a weekly
class arrives as one VEVENT plus an RRULE. Expanding that is the substance
of this module; everything else is reading a few fields off a text format.

Deliberately partial. `BYSETPOS`, `BYMONTHDAY` and per-occurrence overrides
(`RECURRENCE-ID`) are not handled: they are rare in a teaching schedule, and
an occurrence this cannot express is skipped rather than shown wrongly.
"""

import re
from datetime import date, datetime, timedelta, timezone


TAIPEI = timezone(timedelta(hours=8))

# Google writes IANA names. Without tzdata in the runtime, the one zone this
# studio actually uses is handled exactly and the rest fall back to UTC.
KNOWN_ZONES = {"Asia/Taipei": TAIPEI, "UTC": timezone.utc}

WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}

MAX_OCCURRENCES = 400
MAX_HORIZON_DAYS = 400


def unfold(text: str) -> list[str]:
    """Rejoin the continuation lines iCalendar wraps long values into."""

    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def unescape(value: str) -> str:
    out, index = [], 0
    while index < len(value):
        character = value[index]
        if character == "\\" and index + 1 < len(value):
            following = value[index + 1]
            out.append({"n": "\n", "N": "\n"}.get(following, following))
            index += 2
        else:
            out.append(character)
            index += 1
    return "".join(out)


def split_line(line: str) -> tuple[str, dict[str, str], str] | None:
    """`NAME;PARAM=VALUE:the value` → name, params, value."""

    separator = line.find(":")
    if separator < 0:
        return None
    head, value = line[:separator], line[separator + 1 :]
    parts = head.split(";")
    name = parts[0].upper()
    params = {}
    for part in parts[1:]:
        key, _, param_value = part.partition("=")
        params[key.upper()] = param_value.strip('"')
    return name, params, value


def parse_moment(value: str, params: dict[str, str]) -> tuple[datetime, bool] | None:
    """Return the instant and whether it is an all-day date."""

    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        try:
            day = datetime.strptime(value[:8], "%Y%m%d")
        except ValueError:
            return None
        return day.replace(tzinfo=TAIPEI), True

    match = re.fullmatch(r"(\d{8})T(\d{6})(Z?)", value)
    if not match:
        return None
    stamp = datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S")
    if match.group(3) == "Z":
        return stamp.replace(tzinfo=timezone.utc), False
    zone = KNOWN_ZONES.get(params.get("TZID", ""), TAIPEI if "TZID" in params else TAIPEI)
    return stamp.replace(tzinfo=zone), False


def parse_rule(value: str) -> dict[str, str]:
    rule = {}
    for part in value.split(";"):
        key, _, item = part.partition("=")
        if key:
            rule[key.upper()] = item
    return rule


def _matches_byday(moment: datetime, days: list[str]) -> bool:
    return not days or moment.weekday() in [WEEKDAYS[day[-2:]] for day in days if day[-2:] in WEEKDAYS]


def _add_months(moment: datetime, months: int) -> datetime:
    month_index = moment.month - 1 + months
    year = moment.year + month_index // 12
    month = month_index % 12 + 1
    day = min(moment.day, [31, 29 if year % 4 == 0 and (year % 100 or year % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])
    return moment.replace(year=year, month=month, day=day)


def expand(start: datetime, rule: dict[str, str], excluded: set[datetime], horizon: datetime) -> list[datetime]:
    """Occurrences of one rule, up to the horizon.

    Bounded by both a count and a horizon so a malformed rule cannot spin.
    """

    frequency = rule.get("FREQ", "").upper()
    if frequency not in {"DAILY", "WEEKLY", "MONTHLY"}:
        return [start]

    interval = max(1, int(rule.get("INTERVAL", "1") or 1))
    limit = int(rule["COUNT"]) if rule.get("COUNT", "").isdigit() else None
    until = None
    if rule.get("UNTIL"):
        parsed = parse_moment(rule["UNTIL"], {})
        until = parsed[0] if parsed else None

    days = [day for day in rule.get("BYDAY", "").split(",") if day]
    occurrences: list[datetime] = []
    produced = 0

    if frequency == "WEEKLY" and days:
        # Anchor to the Monday of the start's week and walk the chosen days.
        week_start = start - timedelta(days=start.weekday())
        week = 0
        while len(occurrences) < MAX_OCCURRENCES and week < MAX_HORIZON_DAYS:
            for day in days:
                index = WEEKDAYS.get(day[-2:])
                if index is None:
                    continue
                moment = week_start + timedelta(days=index, weeks=week * interval)
                moment = moment.replace(hour=start.hour, minute=start.minute, second=start.second)
                if moment < start:
                    continue
                if until and moment > until:
                    return sorted(occurrences)
                produced += 1
                if limit and produced > limit:
                    return sorted(occurrences)
                if moment <= horizon and moment not in excluded:
                    occurrences.append(moment)
            if week_start + timedelta(weeks=week * interval) > horizon:
                break
            week += 1
        return sorted(occurrences)

    step = {"DAILY": timedelta(days=interval), "WEEKLY": timedelta(weeks=interval)}.get(frequency)
    moment = start
    while len(occurrences) < MAX_OCCURRENCES:
        if until and moment > until:
            break
        if moment > horizon:
            break
        produced += 1
        if limit and produced > limit:
            break
        if moment not in excluded and _matches_byday(moment, days):
            occurrences.append(moment)
        moment = _add_months(moment, interval) if frequency == "MONTHLY" else moment + step
    return occurrences


def parse_events(text: str, now: datetime, horizon_days: int = 60, limit: int = 5) -> list[dict]:
    """Upcoming occurrences, soonest first.

    Only events that have not finished are returned: a class that ended an
    hour ago is not upcoming, and showing it makes the page look stale.
    """

    horizon = now + timedelta(days=horizon_days)
    results: list[dict] = []
    current: dict | None = None

    for line in unfold(text):
        upper = line.strip().upper()
        if upper == "BEGIN:VEVENT":
            current = {"exdates": set()}
            continue
        if upper == "END:VEVENT":
            if current is not None:
                results.extend(_occurrences(current, now, horizon))
            current = None
            continue
        if current is None:
            continue

        parsed = split_line(line)
        if not parsed:
            continue
        name, params, value = parsed
        if name == "DTSTART":
            moment = parse_moment(value, params)
            if moment:
                current["start"], current["all_day"] = moment
        elif name == "DTEND":
            moment = parse_moment(value, params)
            if moment:
                current["end"] = moment[0]
        elif name == "RRULE":
            current["rule"] = parse_rule(value)
        elif name == "EXDATE":
            for item in value.split(","):
                moment = parse_moment(item, params)
                if moment:
                    current["exdates"].add(moment[0])
        elif name in {"SUMMARY", "LOCATION", "DESCRIPTION", "UID"}:
            current[name.lower()] = unescape(value)
        elif name == "RECURRENCE-ID":
            # A single occurrence edited away from its rule. Left out rather
            # than shown at the wrong time.
            current["is_override"] = True

    results.sort(key=lambda event: event["start"])
    return results[:limit]


def _occurrences(event: dict, now: datetime, horizon: datetime) -> list[dict]:
    start = event.get("start")
    if not start or event.get("is_override"):
        return []

    length = (event.get("end") or start) - start
    if length < timedelta(0):
        length = timedelta(0)

    starts = expand(start, event.get("rule") or {}, event["exdates"], horizon) if event.get("rule") else [start]

    out = []
    for moment in starts:
        finish = moment + length
        if finish < now or moment > horizon:
            continue
        out.append(
            {
                "id": f"{event.get('uid', 'event')}-{moment.strftime('%Y%m%dT%H%M%S')}",
                "title": event.get("summary", "").strip() or "（未命名）",
                "start": moment.isoformat(),
                "end": finish.isoformat(),
                "allDay": bool(event.get("all_day")),
                "location": event.get("location", "").strip(),
                "description": event.get("description", "").strip(),
            }
        )
    return out
