"""The iCalendar reader, and the recurrence expansion it exists for.

Samples are shaped the way Google exports them, because that is the only
producer this has to read.
"""

from datetime import datetime, timedelta, timezone

import pytest


TAIPEI = timezone(timedelta(hours=8))
NOW = datetime(2026, 8, 1, 9, 0, tzinfo=TAIPEI)


@pytest.fixture
def ics():
    from shared import ics as module

    return module


def calendar(*events: str) -> str:
    body = "\r\n".join(events)
    return f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Google Inc//Google Calendar\r\n{body}\r\nEND:VCALENDAR\r\n"


def event(**fields: str) -> str:
    lines = ["BEGIN:VEVENT"] + [f"{key.replace('_', '-')}:{value}" for key, value in fields.items()] + ["END:VEVENT"]
    return "\r\n".join(lines)


class TestReadingTheFormat:
    def test_rejoins_folded_lines(self, ics):
        """Long values arrive wrapped, and a title split in half is a bug."""

        folded = "BEGIN:VEVENT\r\nSUMMARY:兒童美術 · 週六上\r\n 午班\r\nDTSTART;TZID=Asia/Taipei:20260808T100000\r\nUID:a\r\nEND:VEVENT"
        events = ics.parse_events(calendar(folded), NOW)
        assert events[0]["title"] == "兒童美術 · 週六上午班"

    def test_unescapes_the_text_fields(self, ics):
        raw = event(
            UID="a",
            SUMMARY=r"成人肌理畫\, 進階",
            DESCRIPTION=r"第一堂\n第二堂",
            LOCATION=r"台中市\; 西區",
            DTSTART_TZID_Asia_Taipei="20260808T100000",
        ).replace("DTSTART-TZID-Asia-Taipei", "DTSTART;TZID=Asia/Taipei")
        parsed = ics.parse_events(calendar(raw), NOW)[0]
        assert parsed["title"] == "成人肌理畫, 進階"
        assert parsed["description"] == "第一堂\n第二堂"
        assert parsed["location"] == "台中市; 西區"

    def test_a_value_containing_a_colon_survives(self, ics):
        raw = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:10:00 開課\r\nDTSTART:20260808T020000Z\r\nEND:VEVENT"
        assert ics.parse_events(calendar(raw), NOW)[0]["title"] == "10:00 開課"

    def test_an_all_day_event_is_marked(self, ics):
        raw = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:展覽\r\nDTSTART;VALUE=DATE:20260810\r\nDTEND;VALUE=DATE:20260811\r\nEND:VEVENT"
        parsed = ics.parse_events(calendar(raw), NOW)[0]
        assert parsed["allDay"] is True

    def test_utc_and_taipei_land_on_the_same_instant(self, ics):
        utc = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:x\r\nDTSTART:20260808T020000Z\r\nEND:VEVENT"
        local = "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:y\r\nDTSTART;TZID=Asia/Taipei:20260808T100000\r\nEND:VEVENT"
        first, second = ics.parse_events(calendar(utc, local), NOW)
        assert datetime.fromisoformat(first["start"]) == datetime.fromisoformat(second["start"])

    def test_an_untitled_event_still_renders(self, ics):
        raw = "BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Asia/Taipei:20260808T100000\r\nEND:VEVENT"
        assert ics.parse_events(calendar(raw), NOW)[0]["title"] == "（未命名）"

    def test_junk_does_not_raise(self, ics):
        assert ics.parse_events("not a calendar at all", NOW) == []
        assert ics.parse_events("", NOW) == []


class TestWhatCountsAsUpcoming:
    def test_a_finished_event_is_dropped(self, ics):
        raw = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:昨天\r\nDTSTART;TZID=Asia/Taipei:20260731T100000\r\nDTEND;TZID=Asia/Taipei:20260731T120000\r\nEND:VEVENT"
        assert ics.parse_events(calendar(raw), NOW) == []

    def test_an_event_running_right_now_is_kept(self, ics):
        """Someone reading the page during class should still see it."""

        raw = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:進行中\r\nDTSTART;TZID=Asia/Taipei:20260801T080000\r\nDTEND;TZID=Asia/Taipei:20260801T110000\r\nEND:VEVENT"
        assert len(ics.parse_events(calendar(raw), NOW)) == 1

    def test_events_beyond_the_horizon_are_dropped(self, ics):
        raw = "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:明年\r\nDTSTART;TZID=Asia/Taipei:20270801T100000\r\nEND:VEVENT"
        assert ics.parse_events(calendar(raw), NOW) == []

    def test_results_are_sorted_and_capped(self, ics):
        events = [
            f"BEGIN:VEVENT\r\nUID:{index}\r\nSUMMARY:第{index}場\r\nDTSTART;TZID=Asia/Taipei:2026081{index}T100000\r\nEND:VEVENT"
            for index in range(9, 1, -1)
        ]
        parsed = ics.parse_events(calendar(*events), NOW, limit=3)
        assert [item["title"] for item in parsed] == ["第2場", "第3場", "第4場"]

    def test_an_edited_single_occurrence_is_skipped(self, ics):
        """Without the original rule it would be shown at the wrong time."""

        raw = (
            "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:改期的那次\r\nRECURRENCE-ID;TZID=Asia/Taipei:20260808T100000"
            "\r\nDTSTART;TZID=Asia/Taipei:20260809T100000\r\nEND:VEVENT"
        )
        assert ics.parse_events(calendar(raw), NOW) == []


class TestRecurrence:
    """The reason this module exists: Google sends the rule, not the dates."""

    def weekly(self, rule: str, **extra: str) -> str:
        lines = [
            "BEGIN:VEVENT",
            "UID:weekly",
            "SUMMARY:週六班",
            "DTSTART;TZID=Asia/Taipei:20260808T100000",
            "DTEND;TZID=Asia/Taipei:20260808T120000",
            f"RRULE:{rule}",
        ]
        lines += [f"{key}:{value}" for key, value in extra.items()]
        return "\r\n".join(lines + ["END:VEVENT"])

    def test_weekly_produces_every_week(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY")), NOW, limit=4)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-08", "2026-08-15", "2026-08-22", "2026-08-29"]

    def test_the_time_of_day_is_preserved(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY")), NOW, limit=2)
        assert all(datetime.fromisoformat(item["start"]).hour == 10 for item in parsed)

    def test_count_limits_the_series(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY;COUNT=2")), NOW, limit=10)
        assert len(parsed) == 2

    def test_until_ends_the_series(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY;UNTIL=20260823T000000Z")), NOW, limit=10)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-08", "2026-08-15", "2026-08-22"]

    def test_interval_skips_weeks(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY;INTERVAL=2")), NOW, limit=3)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-08", "2026-08-22", "2026-09-05"]

    def test_byday_produces_two_classes_a_week(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY;BYDAY=SA,SU")), NOW, limit=4)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-08", "2026-08-09", "2026-08-15", "2026-08-16"]

    def test_exdate_removes_a_cancelled_class(self, ics):
        raw = self.weekly("FREQ=WEEKLY")
        raw = raw.replace("END:VEVENT", "EXDATE;TZID=Asia/Taipei:20260815T100000\r\nEND:VEVENT")
        parsed = ics.parse_events(calendar(raw), NOW, limit=3)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert "2026-08-15" not in days
        assert days == ["2026-08-08", "2026-08-22", "2026-08-29"]

    def test_daily_recurrence(self, ics):
        raw = self.weekly("FREQ=DAILY;COUNT=3")
        parsed = ics.parse_events(calendar(raw), NOW, limit=5)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-08", "2026-08-09", "2026-08-10"]

    def test_monthly_recurrence_keeps_the_day_of_month(self, ics):
        # A wider horizon than the default: three monthly dates do not fit in
        # sixty days, and that cut-off is tested separately.
        raw = self.weekly("FREQ=MONTHLY;COUNT=3")
        parsed = ics.parse_events(calendar(raw), NOW, horizon_days=120, limit=5)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-08", "2026-09-08", "2026-10-08"]

    def test_monthly_lands_on_the_last_day_when_the_month_is_short(self, ics):
        """31 January cannot recur on 31 February."""

        raw = (
            "BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:月底班\r\nDTSTART;TZID=Asia/Taipei:20260831T100000"
            "\r\nRRULE:FREQ=MONTHLY;COUNT=2\r\nEND:VEVENT"
        )
        parsed = ics.parse_events(calendar(raw), NOW, horizon_days=120, limit=5)
        days = [datetime.fromisoformat(item["start"]).date().isoformat() for item in parsed]
        assert days == ["2026-08-31", "2026-09-30"]

    def test_each_occurrence_has_its_own_id(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY")), NOW, limit=3)
        assert len({item["id"] for item in parsed}) == 3

    def test_occurrences_keep_the_duration(self, ics):
        parsed = ics.parse_events(calendar(self.weekly("FREQ=WEEKLY")), NOW, limit=1)
        span = datetime.fromisoformat(parsed[0]["end"]) - datetime.fromisoformat(parsed[0]["start"])
        assert span == timedelta(hours=2)

    def test_an_unbounded_rule_cannot_run_away(self, ics):
        """A rule with no COUNT or UNTIL must still terminate."""

        parsed = ics.parse_events(calendar(self.weekly("FREQ=DAILY")), NOW, horizon_days=365, limit=1000)
        assert 0 < len(parsed) <= ics.MAX_OCCURRENCES

    def test_an_unsupported_frequency_falls_back_to_one_showing(self, ics):
        """Better one correct date than a series invented from a rule we
        do not implement."""

        parsed = ics.parse_events(calendar(self.weekly("FREQ=YEARLY")), NOW, limit=5)
        assert len(parsed) == 1
