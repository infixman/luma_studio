"""The whole-page save, which is the only write path the editor uses.

`replace_items` is the one function here that deletes rows the caller did not
name, so what it decides to keep, insert and drop is worth pinning down. D1 is
faked: these tests are about which statements are issued and with what, not
about SQLite.
"""

import asyncio
import types

import pytest


class FakeStatement:
    def __init__(self, sql: str, log: list, rows: list):
        self.sql = " ".join(sql.split())
        self._log = log
        self._rows = rows
        self.bindings: tuple = ()

    def bind(self, *values):
        self.bindings = values
        return self

    async def run(self):
        self._log.append((self.sql, self.bindings))
        return types.SimpleNamespace(success=True)

    async def all(self):
        self._log.append((self.sql, self.bindings))
        return types.SimpleNamespace(results=self._rows)


class FakeDatabase:
    def __init__(self, rows: list | None = None):
        self.rows = rows or []
        self.log: list[tuple[str, tuple]] = []

    def prepare(self, sql: str):
        rows = self.rows if "SELECT * FROM bio_link_items" in " ".join(sql.split()) else []
        return FakeStatement(sql, self.log, rows)

    def statements(self, keyword: str) -> list[tuple[str, tuple]]:
        return [entry for entry in self.log if entry[0].startswith(keyword)]


def stored(item_id: str, kind: str = "link", position: int = 0) -> dict:
    return {
        "id": item_id,
        "kind": kind,
        "title": f"title {item_id}",
        "url": f"https://example.com/{item_id}",
        "platform": None,
        "position": position,
        "enabled": 1,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


def sent(item_id, kind: str = "link", **overrides) -> dict:
    return {
        "id": item_id,
        "kind": kind,
        "title": "新標題",
        "url": "https://example.com/new",
        "platform": None,
        "enabled": True,
        **overrides,
    }


def save(bio_link, database, items):
    return asyncio.run(bio_link.replace_items(types.SimpleNamespace(DB=database), items))


class TestReplaceItems:
    def test_an_existing_link_is_updated_not_duplicated(self, bio_link):
        database = FakeDatabase([stored("keep")])
        save(bio_link, database, [sent("keep")])

        assert len(database.statements("UPDATE")) == 1
        assert database.statements("INSERT") == []
        assert database.statements("DELETE") == []

    def test_a_link_without_an_id_is_inserted(self, bio_link):
        database = FakeDatabase([])
        save(bio_link, database, [sent(None)])

        inserts = database.statements("INSERT")
        assert len(inserts) == 1
        # The server names the row; the client never gets to choose an id.
        assert inserts[0][1][0] not in {None, ""}

    def test_an_id_the_server_does_not_know_is_treated_as_new(self, bio_link):
        # Otherwise a client could aim an update at a row that is not there,
        # and the save would silently do nothing.
        database = FakeDatabase([])
        save(bio_link, database, [sent("someone-elses-id")])

        assert len(database.statements("INSERT")) == 1
        assert database.statements("UPDATE") == []

    def test_a_link_left_out_of_the_list_is_deleted_with_its_clicks(self, bio_link):
        database = FakeDatabase([stored("keep"), stored("drop")])
        save(bio_link, database, [sent("keep")])

        deletes = database.statements("DELETE")
        assert [entry[1] for entry in deletes] == [("drop",), ("drop",)]
        assert any("bio_link_events" in entry[0] for entry in deletes)

    def test_position_follows_the_order_of_the_list_within_each_kind(self, bio_link):
        database = FakeDatabase([stored("a"), stored("b"), stored("s", kind="social")])
        save(bio_link, database, [sent("b"), sent("s", kind="social"), sent("a")])

        # Bindings are (id, title, url, platform, position, enabled, now).
        positions = {entry[1][0]: entry[1][4] for entry in database.statements("UPDATE")}
        assert positions == {"b": 0, "a": 1, "s": 0}

    def test_the_same_id_twice_only_updates_once(self, bio_link):
        database = FakeDatabase([stored("keep")])
        save(bio_link, database, [sent("keep"), sent("keep")])

        assert len(database.statements("UPDATE")) == 1
        # The duplicate becomes a new row rather than overwriting the first.
        assert len(database.statements("INSERT")) == 1

    def test_refuses_more_links_than_the_page_holds(self, bio_link):
        database = FakeDatabase([])
        with pytest.raises(ValueError):
            save(bio_link, database, [sent(None) for _ in range(bio_link.MAX_ITEMS + 1)])
        assert database.log == []


class JsString:
    """What D1 actually hands back: a JavaScript string, not a Python one.

    Passing one of these to quote() raised `quote_from_bytes() expected
    bytes` in production while every test passed, because the tests used real
    str. Anything that reads a column now gets one of these instead.
    """

    def __init__(self, value: str):
        self._value = value

    def __str__(self):
        return self._value


class TestCalendarCacheVersion:
    def test_survives_a_javascript_string_from_the_database(self, bio_link):
        url = JsString("https://calendar.google.com/calendar/ical/x/public/basic.ics")
        version = JsString("2026-07-28T00:12:03Z")
        assert bio_link.versioned_calendar_url(url, version) == (
            "https://calendar.google.com/calendar/ical/x/public/basic.ics?_v=2026-07-28T00%3A12%3A03Z"
        )


    def test_a_saved_change_produces_a_different_url(self, bio_link):
        url = "https://calendar.google.com/calendar/ical/x/public/basic.ics"
        first = bio_link.versioned_calendar_url(url, "2026-07-27T10:00:00Z")
        second = bio_link.versioned_calendar_url(url, "2026-07-27T10:05:00Z")

        # Same key means the edge answers from cache; the point of the version
        # is that a save cannot be served the previous body.
        assert first != second
        assert first.startswith(url)

    def test_keeps_an_existing_query_string(self, bio_link):
        url = "https://calendar.google.com/calendar/ical/x/public/basic.ics?mode=full"
        assert bio_link.versioned_calendar_url(url, "v1") == f"{url}&_v=v1"

    def test_leaves_the_url_alone_when_nothing_has_been_saved(self, bio_link):
        url = "https://calendar.google.com/calendar/ical/x/public/basic.ics"
        assert bio_link.versioned_calendar_url(url, "") == url

    def test_escapes_the_version(self, bio_link):
        url = "https://calendar.google.com/calendar/ical/x/public/basic.ics"
        assert bio_link.versioned_calendar_url(url, "a b&c") == f"{url}?_v=a%20b%26c"
