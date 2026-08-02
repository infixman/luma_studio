"""The storage page's statements, against an engine that evaluates them.

`FakeDatabase` answers by substring: it hands back whatever the test declared
for a statement that merely *contains* a fragment, so a join onto a column that
does not exist, a correlated EXISTS that multiplies rows, and a DELETE with the
wrong WHERE clause all pass every unit test in the suite. D1 is SQLite, so a
real `sqlite3` connection is the one place those are found out.

Two things are checked here. That the source list and the storage total describe
the same bucket — they disagreed, and a row that was 864 KB on one page and
absent from the total above it is what sent somebody looking for a delete button
that was not there. And that removing a video removes that video, because these
DELETEs are the only statements in the feature that cannot be undone.
"""

import sqlite3

import pytest

from conftest import bind_literals
from test_migrations_sqlite import apply_all


ASSET = "asset-000001"
OTHER = "asset-000002"
# The size of the row that started this: small enough to be invisible on a bill,
# large enough that "0 B" and "864 KB" are obviously not the same claim.
SOURCE_BYTES = 884_736


@pytest.fixture
def database():
    from shared import migrations

    connection = sqlite3.connect(":memory:")
    apply_all(connection, migrations)
    yield connection
    connection.close()


def an_asset(database, asset_id: str, *, status: str = "ready", byte_size: int = SOURCE_BYTES) -> None:
    database.execute(
        "INSERT INTO video_assets (id, title, original_filename, source_key, status,"
        " byte_size, active_encode_version, created_at, updated_at)"
        " VALUES (?, '驗證用—可刪除', 'a.mp4', '', ?, ?, 1, 0, 0)",
        (asset_id, status, byte_size),
    )


def a_session(database, asset_id: str, *, status: str, session_id: str | None = None) -> None:
    database.execute(
        "INSERT INTO video_upload_sessions (id, asset_id, upload_id, part_size, part_count,"
        " status, etag, expires_at, created_at, updated_at)"
        " VALUES (?, ?, 'upload-1', 5242880, 1, ?, NULL, 0, 0, 0)",
        (session_id or f"session-{asset_id}", asset_id, status),
    )


def a_version(database, asset_id: str, *, version: int = 1, byte_size: int = 2_048) -> None:
    database.execute(
        "INSERT INTO video_encode_versions (asset_id, encode_version, object_count, byte_size,"
        " has_poster, verified_at, created_at, updated_at) VALUES (?, ?, 14, ?, 1, 0, 0, 0)",
        (asset_id, version, byte_size),
    )


def a_job(database, asset_id: str, *, status: str = "queued") -> None:
    database.execute(
        "INSERT INTO video_transcode_jobs (id, asset_id, encode_version, attempt, status,"
        " created_at, updated_at) VALUES (?, ?, 1, 1, ?, 0, 0)",
        (f"job-{asset_id}", asset_id, status),
    )


def source_rows(database) -> list[sqlite3.Row]:
    from domain.storage_report import SOURCES_SQL

    database.row_factory = sqlite3.Row
    try:
        return database.execute(SOURCES_SQL).fetchall()
    finally:
        database.row_factory = None


class TestTheListAndTheTotalAgree:
    def test_a_declared_size_with_no_completed_upload_is_not_storage(self, database):
        """The number on the asset row was written when the upload was arranged.
        Nothing has been assembled at the key yet, and the total above the list
        has always said so."""

        an_asset(database, ASSET)

        assert source_rows(database)[0]["source_landed"] == 0

    def test_a_completed_upload_is_an_object_on_both(self, database):
        from domain.storage_report import SOURCE_TOTALS_SQL

        an_asset(database, ASSET)
        a_session(database, ASSET, status="completed")

        assert source_rows(database)[0]["source_landed"] == 1
        assert database.execute(SOURCE_TOTALS_SQL).fetchone() == (SOURCE_BYTES, 1)

    def test_the_list_adds_up_to_the_total(self, database):
        """The point of the whole exercise. Two queries over the same bucket
        that answer different numbers make the cleanup screen unusable: the row
        somebody wants gone is the one the two disagree about."""

        from domain.storage_report import SOURCE_TOTALS_SQL

        an_asset(database, ASSET)
        a_session(database, ASSET, status="completed")
        an_asset(database, OTHER)
        a_session(database, OTHER, status="uploading")
        an_asset(database, "asset-000003")

        listed = sum(row["byte_size"] for row in source_rows(database) if row["source_landed"])
        assert listed == database.execute(SOURCE_TOTALS_SQL).fetchone()[0]

    def test_a_second_session_does_not_double_what_the_versions_hold(self, database):
        """An asset is allowed at most one source upload, but nothing in the
        schema enforces it. Asked as a join, a second row would multiply every
        version row beside it and inflate a total this page exists to shrink."""

        an_asset(database, ASSET)
        a_session(database, ASSET, status="completed")
        a_session(database, ASSET, status="completed", session_id="session-two")
        a_version(database, ASSET, version=1, byte_size=2_048)
        a_version(database, ASSET, version=2, byte_size=1_024)

        row = source_rows(database)[0]
        assert (row["version_count"], row["version_bytes"]) == (2, 3_072)


class TestRemovingOneVideoEntirely:
    """Four statements, and the only interesting thing about them is the WHERE.

    A fake database reports a row changed whatever the clause says, so a DELETE
    that names no asset at all — the classic missing `WHERE` — passes every unit
    test in the suite and empties the library on the deployment.
    """

    def _delete(self, database, asset_id: str) -> None:
        from domain.cleanup import (
            DELETE_ASSET_JOBS_SQL,
            DELETE_ASSET_SESSIONS_SQL,
            DELETE_ASSET_SQL,
            DELETE_ASSET_VERSIONS_SQL,
        )

        for statement in (
            DELETE_ASSET_VERSIONS_SQL,
            DELETE_ASSET_SESSIONS_SQL,
            DELETE_ASSET_JOBS_SQL,
            DELETE_ASSET_SQL,
        ):
            database.execute(bind_literals(statement, asset_id))

    def _populate(self, database) -> None:
        for asset_id in (ASSET, OTHER):
            an_asset(database, asset_id)
            a_session(database, asset_id, status="completed")
            a_version(database, asset_id, version=1)
            a_version(database, asset_id, version=2)
            a_job(database, asset_id, status="failed")

    def test_everything_the_asset_owns_goes(self, database):
        self._populate(database)

        self._delete(database, ASSET)

        for table in ("video_assets", "video_encode_versions", "video_upload_sessions",
                      "video_transcode_jobs"):
            column = "id" if table == "video_assets" else "asset_id"
            assert database.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", (ASSET,)
            ).fetchone()[0] == 0

    def test_the_video_beside_it_is_untouched(self, database):
        self._populate(database)

        self._delete(database, ASSET)

        assert database.execute("SELECT COUNT(*) FROM video_assets").fetchone()[0] == 1
        assert database.execute(
            "SELECT COUNT(*) FROM video_encode_versions WHERE asset_id = ?", (OTHER,)
        ).fetchone()[0] == 2
        assert database.execute(
            "SELECT COUNT(*) FROM video_upload_sessions WHERE asset_id = ?", (OTHER,)
        ).fetchone()[0] == 1
        assert database.execute(
            "SELECT COUNT(*) FROM video_transcode_jobs WHERE asset_id = ?", (OTHER,)
        ).fetchone()[0] == 1
