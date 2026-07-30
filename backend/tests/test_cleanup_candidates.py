"""What may be deleted, and what has to be decided.

The two lists are separate because the consequences are not comparable. An
orphan is rubbish: deleting it loses nothing anybody can name. An original that
no course uses is a video that can never be re-encoded again — the ladder cannot
be rebuilt from the ladder — and that is a decision, not a chore.

So `safe` may be cleared in one action and `needsJudgement` may not, and a source
a lesson still uses appears in neither: not warned about, not offered.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def cleanup():
    from domain import cleanup as module

    return module


ASSET = "asset-000001"
GIGABYTE = 1024 * 1024 * 1024
NOW = 1785292800


def a_source(**extra) -> dict:
    return {
        "assetId": ASSET,
        "title": "第一課",
        "status": "ready",
        "bytes": 4 * GIGABYTE,
        "hasPlayableVersion": True,
        "activeEncodeVersion": 2,
        "versionCount": 2,
        "versionBytes": 3 * GIGABYTE,
        "lessons": [],
        "createdAt": 1_700_000_000,
        **extra,
    }


def a_version(**extra) -> dict:
    return {
        "assetId": ASSET,
        "encodeVersion": 1,
        "objectCount": 14,
        "bytes": GIGABYTE,
        "hasPoster": True,
        "verifiedAt": 1_700_000_000,
        "isActive": False,
        "isSuperseded": True,
        **extra,
    }


def candidates_of(cleanup, *, sources=None, versions=None, scan=None, monkeypatch=None):
    from domain import storage_report, storage_scan

    async def fake_sources(env):
        return list(sources if sources is not None else [])

    async def fake_versions_by_asset(env):
        grouped: dict = {}
        for row in versions or []:
            grouped.setdefault(row["assetId"], []).append(row)
        return grouped

    async def fake_scan(env):
        return scan

    monkeypatch.setattr(storage_report, "sources", fake_sources)
    monkeypatch.setattr(storage_report, "versions_by_asset", fake_versions_by_asset)
    monkeypatch.setattr(storage_scan, "latest_scan", fake_scan)
    return asyncio.run(cleanup.candidates(make_env(FakeDatabase()), now=NOW))


class TestWhatIsSafe:
    def test_orphans_are_safe_and_reported_as_one_entry_per_bucket(self, cleanup, monkeypatch):
        """Deleting them loses nothing anybody can name, and a list of nine
        thousand keys is not something to tick through."""

        found = candidates_of(
            cleanup,
            scan={
                "scanId": "scan-1", "scannedAt": NOW - 60, "truncated": False,
                "sourceBytes": 5 * GIGABYTE, "sourceObjects": 3,
                "outputBytes": 12 * GIGABYTE, "outputObjects": 312,
            },
            monkeypatch=monkeypatch,
        )

        orphans = [entry for entry in found["safe"] if entry["kind"] == "orphan"]
        assert {entry["bucket"] for entry in orphans} == {"source", "output"}
        assert [entry for entry in orphans if entry["bucket"] == "output"][0]["keys"] == 312

    def test_no_sweep_means_no_orphan_entries(self, cleanup, monkeypatch):
        """Not an empty one. "Nothing found" and "never looked" are different,
        and only one of them is a reason to stop looking."""

        found = candidates_of(cleanup, monkeypatch=monkeypatch)

        assert [entry for entry in found["safe"] if entry["kind"] == "orphan"] == []
        assert found["scannedAt"] is None

    def test_a_superseded_version_is_safe_once_the_rollback_window_has_passed(self, cleanup, monkeypatch):
        found = candidates_of(
            cleanup,
            sources=[a_source()],
            versions=[a_version(verifiedAt=NOW - cleanup.ROLLBACK_SECONDS - 1)],
            monkeypatch=monkeypatch,
        )

        superseded = [entry for entry in found["safe"] if entry["kind"] == "supersededVersion"]
        assert superseded and superseded[0]["encodeVersion"] == 1

    def test_a_version_replaced_an_hour_ago_is_not_offered_yet(self, cleanup, monkeypatch):
        """Going back to the previous encode is the recovery for a re-encode
        that turned out wrong, and it is the first hour that anybody notices."""

        found = candidates_of(
            cleanup,
            sources=[a_source()],
            versions=[a_version(verifiedAt=NOW - 3600)],
            monkeypatch=monkeypatch,
        )

        assert [entry for entry in found["safe"] if entry["kind"] == "supersededVersion"] == []

    def test_the_live_version_is_never_offered(self, cleanup, monkeypatch):
        found = candidates_of(
            cleanup,
            sources=[a_source()],
            versions=[a_version(encodeVersion=2, isActive=True, isSuperseded=False, verifiedAt=0)],
            monkeypatch=monkeypatch,
        )

        assert found["safe"] == []


class TestWhatNeedsDeciding:
    def test_a_source_no_course_uses_is_offered_with_its_consequence(self, cleanup, monkeypatch):
        found = candidates_of(cleanup, sources=[a_source()], monkeypatch=monkeypatch)

        unused = [entry for entry in found["needsJudgement"] if entry["kind"] == "unusedSource"]
        assert unused and unused[0]["title"] == "第一課"
        assert "重新轉檔" in unused[0]["consequence"]

    def test_a_source_a_lesson_uses_appears_in_neither_list(self, cleanup, monkeypatch):
        """Not warned about. The rule is that there is no entrance, because a
        warning is a thing somebody clicks past at four in the afternoon."""

        found = candidates_of(
            cleanup,
            sources=[a_source(lessons=[{"lessonId": "l1", "lessonTitle": "工具介紹",
                                        "courseId": "c1", "courseTitle": "水彩入門"}])],
            monkeypatch=monkeypatch,
        )

        assert found["needsJudgement"] == []
        assert found["safe"] == []

    def test_an_upload_that_never_finished_is_not_a_source_to_delete(self, cleanup, monkeypatch):
        """There is no original object to remove — the orphan sweep is what
        finds the parts it did send, and it is the sweep that reports them."""

        found = candidates_of(
            cleanup,
            sources=[a_source(status="uploading", hasPlayableVersion=False, activeEncodeVersion=None)],
            monkeypatch=monkeypatch,
        )

        assert found["needsJudgement"] == []
