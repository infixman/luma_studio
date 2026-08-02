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

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


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


class TestDeletingAnUnfinishedUpload:
    """An upload that stopped, and the invisible bytes it is still holding.

    Parts already sent are a pending multipart upload: R2 bills them, a listing
    does not show them, and the only thing that can end one is the session row.
    So the row must not go until the upload has been cancelled — deleting it
    first leaves storage nothing in the system can name, let alone reach.
    """

    SIGNING = {
        "R2_S3_ENDPOINT": "https://account.r2.cloudflarestorage.com",
        "R2_ACCESS_KEY_ID": "key",
        "R2_SECRET_ACCESS_KEY": "secret",
    }

    def _env(self, answers=None, source=None, *, status="uploading", sessions=None):
        return make_env(
            FakeDatabase(
                {
                    "SELECT * FROM video_assets": [an_asset_row(status=status)],
                    "SELECT * FROM video_upload_sessions": sessions if sessions is not None else [],
                    **(answers or {}),
                }
            ),
            COURSE_SOURCE=source or Bucket(),
            COURSE_VIDEO=Bucket(),
            COURSE_SOURCE_BUCKET="luma-course-source",
            COURSE_VIDEO_BUCKET="luma-course-video",
            **self.SIGNING,
        )

    def _session_row(self, **extra) -> dict:
        return {
            "id": "session-1", "asset_id": ASSET, "upload_id": "upload-1", "part_size": 5_242_880,
            "part_count": 2, "status": "uploading", "etag": None, "expires_at": NOW + 60,
            "created_at": 0, "updated_at": 0,
            **extra,
        }

    def _aborts(self, monkeypatch) -> list:
        from shared import r2_s3

        recorded: list = []

        async def abort_multipart(*, credentials, bucket, key, upload_id, now):
            recorded.append(upload_id)

        monkeypatch.setattr(r2_s3, "abort_multipart", abort_multipart)
        return recorded

    def _delete(self, cleanup, env, *, dry_run=False):
        return asyncio.run(cleanup.delete_upload(env, asset_id=ASSET, dry_run=dry_run, now=NOW))

    def test_the_pending_upload_is_cancelled_before_the_row_goes(self, cleanup, monkeypatch):
        aborted = self._aborts(monkeypatch)
        env = self._env(sessions=[self._session_row()])

        self._delete(cleanup, env)

        assert aborted == ["upload-1"]
        assert [sql for sql, _ in env.DB.writes if "DELETE FROM video_assets" in sql]

    def test_an_upload_that_cannot_be_cancelled_keeps_its_row(self, cleanup, monkeypatch):
        """A visible row is recoverable. Bytes R2 is holding for an upload id
        nothing remembers are not, by anybody, ever."""

        from shared import r2_s3

        async def refuse(**_kwargs):
            raise RuntimeError("R2 is unhappy")

        monkeypatch.setattr(r2_s3, "abort_multipart", refuse)
        env = self._env(sessions=[self._session_row()])

        with pytest.raises(RuntimeError):
            self._delete(cleanup, env)

        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_assets" in sql]

    def test_whatever_landed_in_the_bucket_goes_too(self, cleanup, monkeypatch):
        """A resumed upload can have assembled an object before the asset was
        abandoned, and the sweep only reports what nothing claims — this row
        claims it right up until it is deleted."""

        self._aborts(monkeypatch)
        source = Bucket([f"sources/{ASSET}/1/source.mp4"])
        env = self._env(source=source, status="uploaded")

        removed = self._delete(cleanup, env)

        assert source.deleted == [f"sources/{ASSET}/1/source.mp4"]
        assert removed["rowsRemoved"] == 1

    def test_the_session_rows_go_with_the_asset(self, cleanup, monkeypatch):
        """They describe an upload of a video that no longer exists, and one of
        them is what the source total counts."""

        self._aborts(monkeypatch)
        env = self._env(sessions=[self._session_row()])

        self._delete(cleanup, env)

        assert [sql for sql, _ in env.DB.writes if "DELETE FROM video_upload_sessions" in sql]

    def test_a_finished_video_is_refused(self, cleanup, monkeypatch):
        """This is the door for uploads that stopped. A `ready` video has an
        audience, and removing one is a different decision with its own door."""

        self._aborts(monkeypatch)
        env = self._env(status="ready")

        with pytest.raises(ValueError):
            self._delete(cleanup, env)

    def test_a_lesson_using_it_is_refused(self, cleanup, monkeypatch):
        self._aborts(monkeypatch)
        env = self._env(
            {"SELECT id, section_id, title FROM course_lessons": [
                {"id": "l1", "section_id": "s1", "title": "工具介紹"}
            ]}
        )

        with pytest.raises(ValueError) as raised:
            self._delete(cleanup, env)

        assert "工具介紹" in str(raised.value)

    def test_an_asset_that_does_not_exist_is_not_found(self, cleanup):
        env = self._env({"SELECT * FROM video_assets": []})

        with pytest.raises(LookupError):
            self._delete(cleanup, env)

    def test_a_dry_run_cancels_nothing_and_removes_nothing(self, cleanup, monkeypatch):
        aborted = self._aborts(monkeypatch)
        source = Bucket([f"sources/{ASSET}/1/source.mp4"])
        env = self._env(source=source, sessions=[self._session_row()])

        planned = self._delete(cleanup, env, dry_run=True)

        assert aborted == []
        assert source.deleted == []
        assert planned["deleted"] == [f"sources/{ASSET}/1/source.mp4"]
        assert planned["rowsRemoved"] == 0
        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_assets" in sql]


class TestDeletingAWholeVideo:
    """Source, every encode version, and the row — in that order.

    The order is the whole design. Objects first means a purge that fails
    halfway leaves a row somebody can see and press again; the other way round
    leaves bytes nothing in D1 names, which is the orphan this feature exists to
    stop making.
    """

    def _delete(self, cleanup, env, *, dry_run=False):
        return asyncio.run(cleanup.delete_asset(env, asset_id=ASSET, dry_run=dry_run, now=NOW))

    def _env(self, answers=None, *, source=None, output=None, status="ready"):
        return make_env(
            FakeDatabase({"SELECT * FROM video_assets": [an_asset_row(status=status)], **(answers or {})}),
            COURSE_SOURCE=source or Bucket(),
            COURSE_VIDEO=output or Bucket(),
            COURSE_SOURCE_BUCKET="luma-course-source",
            COURSE_VIDEO_BUCKET="luma-course-video",
        )

    def test_every_version_and_the_original_go(self, cleanup):
        """Not only the live one. The whole point is that nothing of this video
        is left paying rent."""

        source = Bucket([f"sources/{ASSET}/1/source.mp4"])
        output = Bucket([
            f"videos/{ASSET}/1/master.m3u8",
            f"videos/{ASSET}/2/master.m3u8",
            f"videos/{ASSET}/2/720p/segment-000001.m4s",
        ])
        env = self._env(source=source, output=output)

        removed = self._delete(cleanup, env)

        assert source.deleted == [f"sources/{ASSET}/1/source.mp4"]
        assert sorted(output.deleted) == [
            f"videos/{ASSET}/1/master.m3u8",
            f"videos/{ASSET}/2/720p/segment-000001.m4s",
            f"videos/{ASSET}/2/master.m3u8",
        ]
        assert removed["complete"] is True

    def test_the_rows_go_once_the_objects_have(self, cleanup):
        env = self._env(output=Bucket([f"videos/{ASSET}/1/master.m3u8"]))

        removed = self._delete(cleanup, env)

        written = [sql for sql, _ in env.DB.writes]
        assert [sql for sql in written if "DELETE FROM video_encode_versions" in sql]
        assert [sql for sql in written if "DELETE FROM video_assets" in sql]
        assert removed["rowsRemoved"] == 1

    def test_a_video_whose_objects_are_already_gone_still_loses_its_row(self, cleanup):
        """Which is the state four rows are in on the deployment right now: R2
        holds nothing for them and the row is the only thing left. A cleanup
        that only works while there is something to delete cannot clear them."""

        env = self._env()

        removed = self._delete(cleanup, env)

        assert removed["deleted"] == []
        assert removed["rowsRemoved"] == 1

    def test_a_lesson_using_it_is_refused_by_the_function(self, cleanup):
        """Not merely hidden from the list. "There is no button" and "there is
        no way" are different guarantees, and only the second survives a URL."""

        env = self._env(
            {"SELECT id, section_id, title FROM course_lessons": [
                {"id": "l1", "section_id": "s1", "title": "工具介紹"}
            ]},
            output=Bucket([f"videos/{ASSET}/1/master.m3u8"]),
        )

        with pytest.raises(ValueError) as raised:
            self._delete(cleanup, env)

        assert "工具介紹" in str(raised.value)
        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_assets" in sql]

    def test_a_video_being_transcoded_is_refused(self, cleanup):
        """A container is writing its objects. Whatever it writes after the row
        is gone belongs to nothing."""

        env = self._env(status="processing")

        with pytest.raises(ValueError):
            self._delete(cleanup, env)

    def test_an_upload_that_never_finished_is_sent_to_the_other_door(self, cleanup):
        """This one does not cancel pending multipart uploads, so taking the row
        here would leave R2 holding parts whose id nothing remembers. The upload
        deletion exists precisely to end those first."""

        env = self._env(status="uploading")

        with pytest.raises(ValueError):
            self._delete(cleanup, env)

    def test_a_dry_run_removes_nothing_and_lists_what_would_go(self, cleanup):
        source = Bucket([f"sources/{ASSET}/1/source.mp4"])
        output = Bucket([f"videos/{ASSET}/1/master.m3u8"])
        env = self._env(source=source, output=output)

        planned = self._delete(cleanup, env, dry_run=True)

        assert (source.deleted, output.deleted) == ([], [])
        assert sorted(planned["deleted"]) == [
            f"sources/{ASSET}/1/source.mp4",
            f"videos/{ASSET}/1/master.m3u8",
        ]
        assert planned["rowsRemoved"] == 0
        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_assets" in sql]

    def test_a_video_with_more_objects_than_one_run_can_remove_keeps_its_row(self, cleanup, monkeypatch):
        """The row is what names the leftovers. Removing it while they are still
        there turns a half-finished cleanup into orphans."""

        monkeypatch.setattr(cleanup, "MAX_DELETES", 2)
        env = self._env(output=Bucket([f"videos/{ASSET}/1/segment-{index:06d}.m4s" for index in range(5)]))

        removed = self._delete(cleanup, env)

        assert removed["complete"] is False
        assert removed["rowsRemoved"] == 0
        assert not [sql for sql, _ in env.DB.writes if "DELETE FROM video_assets" in sql]

    def test_the_ceiling_is_one_budget_across_both_buckets(self, cleanup, monkeypatch):
        """It bounds the requests one invocation makes, and a video has objects
        in two buckets — allowing each of them the whole of it is twice the work
        the number was chosen to permit. What is left over keeps the row."""

        monkeypatch.setattr(cleanup, "MAX_DELETES", 6)
        source = Bucket([f"sources/{ASSET}/1/part-{index}" for index in range(3)])
        output = Bucket([f"videos/{ASSET}/1/segment-{index:06d}.m4s" for index in range(5)])
        env = self._env(source=source, output=output)

        removed = self._delete(cleanup, env)

        assert len(removed["deleted"]) == 6
        assert (len(output.deleted), len(source.deleted)) == (5, 1)
        assert removed["complete"] is False
        assert removed["rowsRemoved"] == 0


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


class TestTheEndpointItself:
    """The one entrance, and what it does with the two new kinds of removal.

    Worth a route test rather than only a domain one because the refusals are
    the point of the endpoint: "a lesson is using this" has to arrive as a 409
    that says so, not as a 500 that says nothing and not as a 200 that deleted
    a video somebody is watching.
    """

    ADMIN_HOST = "admin-api.luma-studio.tw"
    HEADERS = {
        "Origin": ADMIN_ORIGIN,
        "x-luma-app": "1",
        "Cookie": "luma_admin_session=" + "a" * 40,
    }
    SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}

    class JsonRequest(FakeRequest):
        def __init__(self, body: dict, headers: dict):
            super().__init__("/api/video-storage/cleanup", "POST", headers, host="admin-api.luma-studio.tw")
            self._body = body

        async def json(self):
            return self._body

    def _post(self, body, answers=None, *, source=None, output=None):
        import admin_main
        from shared import migrations

        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            FakeDatabase({**self.SIGNED_IN, "SELECT * FROM video_assets": [an_asset_row()],
                          **(answers or {})}),
            origins=ADMIN_ORIGIN,
            frontend=ADMIN_ORIGIN,
            COURSE_SOURCE=source or Bucket(),
            COURSE_VIDEO=output or Bucket(),
            COURSE_SOURCE_BUCKET="luma-course-source",
            COURSE_VIDEO_BUCKET="luma-course-video",
        )
        return asyncio.run(worker.fetch(self.JsonRequest(body, self.HEADERS)))

    def test_it_deletes_a_whole_video(self, cleanup):
        output = Bucket([f"videos/{ASSET}/1/master.m3u8"])

        response = self._post({"kind": "entireVideo", "assetId": ASSET}, output=output)

        assert response.status == 200
        assert response.json()["rowsRemoved"] == 1
        assert output.deleted == [f"videos/{ASSET}/1/master.m3u8"]

    def test_deleting_a_video_a_lesson_uses_is_refused(self, cleanup):
        response = self._post(
            {"kind": "entireVideo", "assetId": ASSET},
            {"SELECT id, section_id, title FROM course_lessons": [
                {"id": "l1", "section_id": "s1", "title": "工具介紹"}
            ]},
        )

        assert response.status == 409
        assert "工具介紹" in response.json()["error"]

    def test_it_deletes_an_upload_that_never_finished(self, cleanup):
        response = self._post(
            {"kind": "unfinishedUpload", "assetId": ASSET},
            {"SELECT * FROM video_assets": [an_asset_row(status="uploading")]},
        )

        assert response.status == 200
        assert response.json()["rowsRemoved"] == 1

    def test_a_kind_nobody_offers_is_refused_before_anything_is_read(self, cleanup):
        response = self._post({"kind": "everything", "assetId": ASSET})

        assert response.status == 400
