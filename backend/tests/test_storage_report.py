"""The two lists somebody deletes from.

Shaped by the decision they support rather than by the tables behind them.
Nobody retires a video because it is four gigabytes; they retire it because the
course it belonged to closed last year — so a source row carries the lessons
that use it, and a version row says whether it is the one members are watching.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def storage_report():
    from domain import storage_report as module

    return module


ASSET = "asset-000001"
GIGABYTE = 1024 * 1024 * 1024


def a_source_row(**extra) -> dict:
    return {
        "id": ASSET,
        "title": "第一課",
        "status": "ready",
        "byte_size": 4 * GIGABYTE,
        "active_encode_version": 2,
        "created_at": 1_700_000_000,
        "version_count": 2,
        "version_bytes": 3 * GIGABYTE,
        **extra,
    }


def a_version_row(**extra) -> dict:
    return {
        "asset_id": ASSET,
        "encode_version": 1,
        "object_count": 14,
        "byte_size": GIGABYTE,
        "has_poster": 1,
        "verified_at": 1_700_000_000,
        "active_encode_version": 2,
        **extra,
    }


def listing(storage_report, what, answers, **kwargs):
    env = make_env(FakeDatabase(answers))
    return asyncio.run(getattr(storage_report, what)(env, **kwargs))


class TestTheSourceList:
    def _rows(self, storage_report, source=None, lessons=None):
        return listing(
            storage_report,
            "sources",
            {
                "FROM video_assets assets": [source or a_source_row()],
                "FROM course_lessons": lessons or [],
            },
        )

    def test_it_reports_what_the_original_occupies(self, storage_report):
        row = self._rows(storage_report)[0]

        assert row["assetId"] == ASSET
        assert row["bytes"] == 4 * GIGABYTE
        assert row["versionCount"] == 2
        assert row["versionBytes"] == 3 * GIGABYTE

    def test_it_says_whether_anything_can_play(self, storage_report):
        """"No playable version" means the upload never finished, not that the
        video is old — opposite conclusions about whether to delete it."""

        assert self._rows(storage_report)[0]["hasPlayableVersion"] is True
        without = self._rows(storage_report, source=a_source_row(active_encode_version=None))
        assert without[0]["hasPlayableVersion"] is False

    def test_the_lessons_using_it_come_with_it(self, storage_report):
        """A number would not do. The decision is not "3 lessons", it is "oh,
        that course closed last year"."""

        rows = self._rows(
            storage_report,
            lessons=[{"video_asset_id": ASSET, "lesson_id": "l1", "lesson_title": "工具介紹",
                      "course_id": "c1", "course_title": "水彩入門"}],
        )

        assert rows[0]["lessons"] == [
            {"lessonId": "l1", "lessonTitle": "工具介紹", "courseId": "c1", "courseTitle": "水彩入門"}
        ]

    def test_a_source_nothing_uses_says_so_plainly(self, storage_report):
        assert self._rows(storage_report)[0]["lessons"] == []

    def test_one_query_answers_the_lessons_for_every_row(self, storage_report):
        """A query per row is what turns a page into a hundred round trips."""

        database = FakeDatabase(
            {"FROM video_assets assets": [a_source_row(), a_source_row(id="asset-2")],
             "FROM course_lessons": []}
        )
        asyncio.run(storage_report.sources(make_env(database)))

        assert len([sql for sql, _ in database.reads if "course_lessons" in sql]) == 1


class TestTheVersionList:
    def _rows(self, storage_report, *versions):
        return listing(
            storage_report,
            "versions",
            {"FROM video_encode_versions": list(versions) or [a_version_row()]},
            asset_id=ASSET,
        )

    def test_a_version_reports_what_it_holds(self, storage_report):
        row = self._rows(storage_report)[0]

        assert row["encodeVersion"] == 1
        assert row["objectCount"] == 14
        assert row["bytes"] == GIGABYTE
        assert row["verifiedAt"] == 1_700_000_000

    def test_the_live_one_is_marked(self, storage_report):
        """Deleting it is deleting what members are watching, and the list is
        where somebody decides."""

        rows = self._rows(storage_report, a_version_row(encode_version=2), a_version_row(encode_version=1))

        by_version = {row["encodeVersion"]: row for row in rows}
        assert by_version[2]["isActive"] is True
        assert by_version[1]["isActive"] is False

    def test_a_replaced_version_says_it_was_replaced(self, storage_report):
        """"Superseded" is the only safe thing on this page, and it is not the
        same as "old"."""

        rows = self._rows(storage_report, a_version_row(encode_version=1))

        assert rows[0]["isSuperseded"] is True

    def test_a_version_of_an_asset_with_none_live_is_not_superseded(self, storage_report):
        """Nothing replaced it. The upload never finished, which is a different
        thing to say and a different decision."""

        rows = self._rows(storage_report, a_version_row(encode_version=1, active_encode_version=None))

        assert rows[0]["isSuperseded"] is False
        assert rows[0]["isActive"] is False
