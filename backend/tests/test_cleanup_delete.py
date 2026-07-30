"""Actually removing things, which is the only irreversible action here.

Three rules, and each one exists because the list somebody is looking at was
built at some point in the past:

The references are checked again at delete time. A lesson can start using a
source between the page loading and the button being pressed, and the page is
not the authority.

A dry run is the same code path as the deletion, minus the deleting. A preview
produced by different code is a preview of something else.

A source a course uses is refused by the endpoint, not only hidden from the
list. "There is no button" and "there is no way" are different guarantees, and
only the second one survives somebody with a URL.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def cleanup():
    from domain import cleanup as module

    return module


ASSET = "asset-000001"
NOW = 1785292800


class Bucket:
    def __init__(self, keys=()):
        self.keys = list(keys)
        self.deleted: list[str] = []

    async def list(self, *, prefix, limit, cursor=None):
        import types

        objects = [
            types.SimpleNamespace(key=key, size=1024, uploaded=types.SimpleNamespace(getTime=lambda: 0))
            for key in self.keys
            if key.startswith(prefix)
        ]
        return types.SimpleNamespace(objects=objects, truncated=False, cursor=None)

    async def delete(self, key):
        self.deleted.append(key)
        self.keys = [existing for existing in self.keys if existing != key]


def an_asset_row(**extra) -> dict:
    return {
        "id": ASSET, "title": "第一課", "original_filename": "a.mp4", "source_key": "",
        "status": "ready", "byte_size": 1, "duration_seconds": None, "width": None,
        "height": None, "active_encode_version": 2, "master_key": None, "poster_key": None,
        "error_code": None, "error_detail": None, "created_at": 0, "updated_at": 0,
        **extra,
    }


def env_with(answers=None, source=None, output=None):
    return make_env(
        FakeDatabase({"SELECT * FROM video_assets": [an_asset_row()], **(answers or {})}),
        COURSE_SOURCE=source or Bucket(),
        COURSE_VIDEO=output or Bucket(),
        COURSE_SOURCE_BUCKET="luma-course-source",
        COURSE_VIDEO_BUCKET="luma-course-video",
    )


class TestDeletingAnUnusedSource:
    def _delete(self, cleanup, env, *, dry_run=False):
        return asyncio.run(
            cleanup.delete_source(env, asset_id=ASSET, dry_run=dry_run, now=NOW)
        )

    def test_a_source_a_lesson_uses_is_refused_by_the_endpoint(self, cleanup):
        """Not merely hidden from the list. "There is no button" and "there is
        no way" are different guarantees, and the second is the one that holds
        when somebody has the URL."""

        env = env_with(
            {"SELECT id, section_id, title FROM course_lessons": [
                {"id": "l1", "section_id": "s1", "title": "工具介紹"}
            ]}
        )

        with pytest.raises(ValueError) as raised:
            self._delete(cleanup, env)

        assert "工具介紹" in str(raised.value)

    def test_the_references_are_read_again_rather_than_trusted(self, cleanup):
        """The list was built at some point in the past, and a lesson can start
        using this between then and now."""

        database = FakeDatabase({"SELECT * FROM video_assets": [an_asset_row()]})
        env = make_env(database, COURSE_SOURCE=Bucket([f"sources/{ASSET}/1/source.mp4"]),
                       COURSE_VIDEO=Bucket(), COURSE_SOURCE_BUCKET="s", COURSE_VIDEO_BUCKET="v")

        self._delete(cleanup, env)

        assert [sql for sql, _ in database.reads if "course_lessons" in sql]

    def test_it_removes_the_object_and_says_what_it_removed(self, cleanup):
        source = Bucket([f"sources/{ASSET}/1/source.mp4"])
        env = env_with(source=source)

        removed = self._delete(cleanup, env)

        assert source.deleted == [f"sources/{ASSET}/1/source.mp4"]
        assert removed["deleted"] == [f"sources/{ASSET}/1/source.mp4"]

    def test_an_upload_still_in_progress_is_refused(self, cleanup):
        """Its objects are being written right now, and the parts already sent
        belong to a session that can still finish."""

        env = env_with({"SELECT * FROM video_assets": [an_asset_row(status="uploading")]})

        with pytest.raises(ValueError):
            self._delete(cleanup, env)

    def test_an_asset_that_does_not_exist_is_not_found(self, cleanup):
        env = env_with({"SELECT * FROM video_assets": []})

        with pytest.raises(LookupError):
            self._delete(cleanup, env)

    def test_a_dry_run_removes_nothing_and_lists_the_same_thing(self, cleanup):
        """The preview is this code with the deleting turned off. A preview
        produced by different code is a preview of something else."""

        source = Bucket([f"sources/{ASSET}/1/source.mp4"])
        env = env_with(source=source)

        planned = self._delete(cleanup, env, dry_run=True)

        assert source.deleted == []
        assert planned["deleted"] == [f"sources/{ASSET}/1/source.mp4"]
        assert planned["dryRun"] is True


class TestDeletingASupersededVersion:
    def _delete(self, cleanup, env, *, version=1, dry_run=False):
        return asyncio.run(
            cleanup.delete_version(env, asset_id=ASSET, encode_version=version, dry_run=dry_run, now=NOW)
        )

    def _asset_row(self, active=2):
        return {"SELECT * FROM video_assets": [
            {
                "id": ASSET, "title": "第一課", "original_filename": "a.mp4",
                "source_key": "", "status": "ready", "byte_size": 1, "duration_seconds": None,
                "width": None, "height": None, "active_encode_version": active,
                "master_key": None, "poster_key": None, "error_code": None,
                "error_detail": None, "created_at": 0, "updated_at": 0,
            }
        ]}

    def test_the_live_version_is_refused(self, cleanup):
        """Deleting it is deleting what members are watching. The list never
        offers it; this is what makes that a rule rather than a habit."""

        env = env_with(self._asset_row(active=1))

        with pytest.raises(ValueError):
            self._delete(cleanup, env, version=1)

    def test_a_version_replaced_moments_ago_is_refused(self, cleanup):
        """The list keeps it back for a week so somebody can roll back to it.
        Knowing an id and a number must not be a way around that."""

        env = env_with(
            {
                **self._asset_row(active=2),
                "FROM video_encode_versions versions": [
                    {
                        "asset_id": ASSET, "encode_version": 1, "object_count": 14,
                        "byte_size": 1024, "has_poster": 1, "verified_at": NOW - 60,
                        "active_encode_version": 2,
                    }
                ],
            }
        )

        with pytest.raises(ValueError):
            self._delete(cleanup, env, version=1)

    def test_a_superseded_version_takes_its_objects_with_it(self, cleanup):
        output = Bucket([
            f"videos/{ASSET}/1/master.m3u8",
            f"videos/{ASSET}/1/720p/segment-000001.m4s",
            f"videos/{ASSET}/2/master.m3u8",
        ])
        env = env_with(self._asset_row(active=2), output=output)

        removed = self._delete(cleanup, env, version=1)

        assert sorted(output.deleted) == [
            f"videos/{ASSET}/1/720p/segment-000001.m4s",
            f"videos/{ASSET}/1/master.m3u8",
        ]
        assert removed["rowsRemoved"] == 1

    def test_the_version_row_goes_only_when_the_objects_do(self, cleanup):
        """A dry run that removed the row would leave the objects unfindable —
        an orphan created by the preview of a deletion."""

        output = Bucket([f"videos/{ASSET}/1/master.m3u8"])
        env = env_with(self._asset_row(active=2), output=output)

        planned = self._delete(cleanup, env, version=1, dry_run=True)

        assert output.deleted == []
        assert planned["rowsRemoved"] == 0
        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_encode_versions" in sql]


class TestAVersionTooBigForOnePage:
    """A ladder is more objects than one listing answers with.

    The row that names them must not go while any of them are still there: an
    object nothing records is precisely the orphan this feature exists to stop
    making, and deleting the row is what makes it one.
    """

    class PagedBucket(Bucket):
        def __init__(self, keys, page=2):
            super().__init__(keys)
            self.page = page

        async def list(self, *, prefix, limit, cursor=None):
            import types

            matching = [key for key in self.keys if key.startswith(prefix)]
            start = int(cursor or 0)
            window = matching[start : start + self.page]
            more = start + self.page < len(matching)
            objects = [
                types.SimpleNamespace(key=key, size=1, uploaded=types.SimpleNamespace(getTime=lambda: 0))
                for key in window
            ]
            return types.SimpleNamespace(
                objects=objects, truncated=more, cursor=str(start + self.page) if more else None
            )

    def test_every_page_is_read(self, cleanup):
        keys = [f"videos/{ASSET}/1/segment-{index:06d}.m4s" for index in range(5)]
        output = self.PagedBucket(keys)
        env = env_with(
            {"SELECT * FROM video_assets": [an_asset_row(active_encode_version=2)]}, output=output
        )

        removed = asyncio.run(
            cleanup.delete_version(env, asset_id=ASSET, encode_version=1, dry_run=False, now=NOW)
        )

        assert sorted(output.deleted) == sorted(keys)
        assert removed["complete"] is True

    def test_a_version_with_more_objects_than_one_run_can_remove_keeps_its_row(self, cleanup, monkeypatch):
        """Otherwise the leftovers become objects no row names — an orphan the
        cleanup created."""

        monkeypatch.setattr(cleanup, "MAX_DELETES", 4)
        keys = [f"videos/{ASSET}/1/segment-{index:06d}.m4s" for index in range(10)]
        env = env_with(
            {"SELECT * FROM video_assets": [an_asset_row(active_encode_version=2)]},
            output=self.PagedBucket(keys),
        )

        removed = asyncio.run(
            cleanup.delete_version(env, asset_id=ASSET, encode_version=1, dry_run=False, now=NOW)
        )

        assert removed["complete"] is False
        assert removed["rowsRemoved"] == 0
        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_encode_versions" in sql]


class TestClearingOrphans:
    def _clear(self, cleanup, env, *, bucket="output", dry_run=False):
        return asyncio.run(cleanup.delete_orphans(env, bucket=bucket, dry_run=dry_run))

    def _scan_rows(self, keys):
        return {
            "FROM video_storage_scans WHERE finished_at IS NOT NULL": [
                {
                    "id": "scan-1", "finished_at": NOW, "truncated": 0,
                    "source_orphan_bytes": 0, "source_orphan_objects": 0,
                    "output_orphan_bytes": 1024, "output_orphan_objects": len(keys),
                }
            ],
            "FROM video_storage_orphans": [
                {"object_key": key, "byte_size": 1024, "uploaded_at": 0} for key in keys
            ],
        }

    def test_it_removes_what_the_last_sweep_found(self, cleanup):
        output = Bucket([f"videos/{ASSET}/9/master.m3u8"])
        env = env_with(self._scan_rows([f"videos/{ASSET}/9/master.m3u8"]), output=output)

        removed = self._clear(cleanup, env)

        assert output.deleted == [f"videos/{ASSET}/9/master.m3u8"]
        assert removed["deleted"] == [f"videos/{ASSET}/9/master.m3u8"]

    def test_a_dry_run_removes_nothing(self, cleanup):
        output = Bucket([f"videos/{ASSET}/9/master.m3u8"])
        env = env_with(self._scan_rows([f"videos/{ASSET}/9/master.m3u8"]), output=output)

        self._clear(cleanup, env, dry_run=True)

        assert output.deleted == []

    def test_with_no_sweep_there_is_nothing_to_clear(self, cleanup):
        """Not "delete everything unaccounted for". This endpoint removes what a
        sweep wrote down, so a deployment that never swept removes nothing."""

        output = Bucket([f"videos/{ASSET}/9/master.m3u8"])
        env = env_with(output=output)

        removed = self._clear(cleanup, env)

        assert output.deleted == []
        assert removed["deleted"] == []
