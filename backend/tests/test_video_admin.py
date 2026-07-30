"""The video library, minus the parts that need a bucket.

Listing, archiving and reference checks are all database work. Uploading and
transcoding need R2, a queue and a container, and are not here.
"""

import asyncio
import types

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}
ASSET_ID = "asset-000001"


def an_asset(**extra) -> dict:
    return {
        "id": ASSET_ID, "title": "第一課", "original_filename": "lesson-01.mp4",
        "source_key": "sources/asset-000001/1/source.mp4", "status": "ready",
        "byte_size": 2_000_000, "duration_seconds": 600, "width": 1920, "height": 1080,
        "active_encode_version": 1, "master_key": "videos/asset-000001/1/master.m3u8",
        "poster_key": None, "error_code": None, "error_detail": None,
        "created_at": 0, "updated_at": 0,
        **extra,
    }


class JsonRequest(FakeRequest):
    def __init__(self, path: str, method: str, body: dict, headers: dict | None = None):
        super().__init__(path, method, headers, host=ADMIN_HOST)
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def database_of():
    """A database a test can inspect after the request, not only answer with."""

    def build(answers=None, changes=None) -> FakeDatabase:
        return FakeDatabase({**SIGNED_IN, **(answers or {})}, changes=changes)

    return build


@pytest.fixture
def call(database_of):
    import admin_main
    from shared import migrations

    def run(request, answers=None, changes=None, bucket=None, database=None, env=None, source_bucket=None):
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            database if database is not None else database_of(answers, changes),
            origins=ADMIN_ORIGIN,
            frontend=ADMIN_ORIGIN,
            **(env or {}),
        )
        if bucket is not None:
            worker.env.COURSE_VIDEO = bucket
        # `False` means "a deployment without the binding", which `None` cannot
        # say — that is the default.
        if source_bucket is not None:
            worker.env.COURSE_SOURCE = source_bucket or None
        return asyncio.run(worker.fetch(request))

    return run


def signed_in(path: str, method: str = "GET"):
    return FakeRequest(
        path,
        method,
        {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
        host=ADMIN_HOST,
    )


class TestTheLibrary:
    def test_an_empty_library_lists_nothing(self, call):
        response = call(signed_in("/api/video-assets"))

        assert response.status == 200
        assert response.json()["assets"] == []

    def test_an_asset_is_listed_without_its_object_keys(self, call):
        """These rows go to a browser. A key is a thing to go looking for, and
        the bucket being private is not a reason to publish the map."""

        response = call(signed_in("/api/video-assets"), {"SELECT * FROM video_assets": [an_asset()]})

        body = response.json()
        assert body["assets"][0]["title"] == "第一課"
        assert "sourceKey" not in body["assets"][0]
        assert "master_key" not in str(body)

    def test_an_unknown_asset_is_reported_as_missing(self, call):
        assert call(signed_in("/api/video-assets/" + ASSET_ID)).status == 404

    def test_it_is_not_readable_without_a_session(self, call):
        anonymous = FakeRequest(
            "/api/video-assets", "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST
        )

        assert call(anonymous).status == 401


class TestArchiving:
    def test_a_video_a_lesson_uses_cannot_be_archived(self, call):
        """Archiving it would leave a published lesson pointing at nothing.
        Replace the video on the lesson first."""

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/archive", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset()],
                "SELECT id, section_id, title FROM course_lessons": [
                    {"id": "l1", "section_id": "s1", "title": "工具介紹"}
                ],
            },
        )

        assert response.status == 409
        assert "工具介紹" in response.json()["error"]

    def test_a_video_nothing_uses_can_be_archived(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/archive", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset()],
                # The move is checked against the status the row is read at.
                "SELECT status FROM video_assets": [{"status": "ready"}],
            },
        )

        assert response.status == 200

    def test_what_uses_a_video_can_be_asked_for(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/references"),
            {
                "SELECT * FROM video_assets": [an_asset()],
                "SELECT id, section_id, title FROM course_lessons": [
                    {"id": "l1", "section_id": "s1", "title": "工具介紹"}
                ],
            },
        )

        assert response.status == 200
        assert response.json()["lessons"][0]["title"] == "工具介紹"


class TestAbandoningAnUpload:
    """The exit an upload that stopped halfway did not have.

    Only `ready` and `failed` reach `archived`, so an asset the tool created and
    never finished uploading had no button in the back office at all — and
    production has one: the row left behind when import collided on the primary
    key. Its objects are in R2 and nothing in D1 says the upload is over, which
    is also what keeps the orphan scan from touching them.
    """

    def _abort(self, call, asset, database=None):
        return call(
            signed_in(f"/api/video-assets/{ASSET_ID}/abort", "POST"),
            {
                "SELECT * FROM video_assets": [asset],
                "SELECT status FROM video_assets": [{"status": asset["status"]}],
            },
            database=database,
        )

    def test_an_unfinished_upload_can_be_abandoned(self, call, database_of):
        database = database_of(
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading", active_encode_version=None)],
                "SELECT status FROM video_assets": [{"status": "uploading"}],
            }
        )

        response = call(signed_in(f"/api/video-assets/{ASSET_ID}/abort", "POST"), database=database)

        assert response.status == 200
        # On the UPDATE, not on the row read back: the fake answers reads from
        # what this test declared, so it would report 'aborted' either way.
        moves = [
            bindings
            for sql, bindings in database.writes
            if sql.startswith("UPDATE video_assets") and "status = ?2" in sql
        ]
        assert moves and moves[0][1] == "aborted"

    def test_a_playable_video_is_not_abandoned_it_is_archived(self, call):
        """`ready -> aborted` is not a move the pipeline makes. Answering 200 to a
        request that changed nothing is the worst of the options."""

        response = self._abort(call, an_asset(status="ready"))

        assert response.status == 409

    def test_a_video_a_lesson_uses_is_refused_by_name(self, call):
        """Same check as archiving, and for the same reason: the lesson would be
        left pointing at nothing, and a member would find out before an admin."""

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/abort", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT status FROM video_assets": [{"status": "uploading"}],
                "SELECT id, section_id, title FROM course_lessons": [
                    {"id": "l1", "section_id": "s1", "title": "工具介紹"}
                ],
            },
        )

        assert response.status == 409
        assert "工具介紹" in response.json()["error"]

    def test_an_unknown_asset_is_not_found(self, call):
        assert call(signed_in(f"/api/video-assets/{ASSET_ID}/abort", "POST")).status == 404

    def test_it_needs_a_session(self, call):
        anonymous = FakeRequest(
            f"/api/video-assets/{ASSET_ID}/abort",
            "POST",
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"},
            host=ADMIN_HOST,
        )

        assert call(anonymous).status == 401


class TestBrowsingTheBuckets:
    """Read-only, and it exists so somebody can confirm an upload arrived.

    Confirming does not need the ability to read the bytes back, so nothing here
    signs a URL — the playback gateway is the entrance to those objects and a
    second one is a second thing to get right.
    """

    class Bucket:
        def __init__(self, keys=("sources/asset-000001/1/source.mp4",)):
            self.keys = keys
            self.asked: list[dict] = []

        async def list(self, *, prefix, limit, cursor=None):
            import types

            self.asked.append({"prefix": prefix, "limit": limit, "cursor": cursor})
            objects = [
                types.SimpleNamespace(key=key, size=1024, uploaded=types.SimpleNamespace(getTime=lambda: 1785292800000))
                for key in self.keys
            ]
            return types.SimpleNamespace(objects=objects, truncated=False, cursor=None)

    def _call(self, call, query="?prefix=sources/asset-000001/", bucket=None, env=None):
        return call(
            signed_in(f"/api/video-storage{query}"),
            env={**({"VIDEO_UPLOAD_ENABLED": "1"}), **(env or {})},
            source_bucket=bucket if bucket is not None else self.Bucket(),
        )

    def test_it_lists_what_is_there(self, call):
        response = self._call(call)

        assert response.status == 200
        listed = response.json()["objects"]
        assert listed[0]["key"] == "sources/asset-000001/1/source.mp4"
        assert listed[0]["size"] == 1024

    def test_it_hands_out_no_urls(self, call):
        """A browse that returns signed URLs is a download endpoint wearing a
        different name."""

        response = self._call(call)

        assert "X-Amz-Signature" not in response.body
        assert "url" not in response.body

    def test_the_whole_bucket_is_not_a_prefix(self, call):
        """`list` with no prefix walks everything, one billed page at a time."""

        assert self._call(call, query="?prefix=").status == 400

    @pytest.mark.parametrize("prefix", ["../secrets/", "sources/../videos/", "/sources/"])
    def test_somewhere_else_entirely_is_refused(self, call, prefix):
        """R2 keys are literal strings, so `..` in a prefix matches nothing
        rather than escaping anywhere — but a prefix that looks like a path and
        is not treated as one is the kind of thing that stops being true when
        somebody puts a bucket behind a filesystem cache."""

        assert self._call(call, query=f"?prefix={prefix}").status == 400

    def test_a_deployment_with_no_bucket_says_so(self, call):
        assert self._call(call, bucket=False).status == 503


class TestTheStorageOverview:
    """Capacity and cost, so somebody remembers to clean up."""

    def test_it_reports_what_is_stored_and_what_it_costs(self, call):
        response = call(
            signed_in("/api/video-storage/summary"),
            {
                "COUNT(*) AS objects FROM video_assets": [{"bytes": 200 * 1024**3, "objects": 42}],
                "FROM video_encode_versions": [{"bytes": 90 * 1024**3, "objects": 8734}],
            },
            env={"R2_PRICE_PER_GB_MONTH_USD": "0.015", "R2_FREE_GB": "10"},
        )

        assert response.status == 200
        body = response.json()
        assert body["source"]["objects"] == 42
        assert body["estimate"]["monthlyUsd"] > 0
        assert body["estimate"]["excludesOperations"] is True

    def test_a_deployment_with_no_price_shows_no_estimate(self, call):
        response = call(signed_in("/api/video-storage/summary"))

        assert response.status == 200
        assert response.json()["estimate"] is None

    def test_it_needs_a_session(self, call):
        anonymous = FakeRequest(
            "/api/video-storage/summary", "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"},
            host=ADMIN_HOST,
        )

        assert call(anonymous).status == 401

    def test_the_desktop_token_cannot_read_it(self):
        """Cost and capacity are the back office's business. The tool's token is
        for getting a video in, and this route is not part of that."""

        from domain import desktop_auth as module

        assert module.scope_allows("video", "GET", "/api/video-storage/summary") is False


class TestSweepingForOrphans:
    """The one action that reads the buckets."""

    class Bucket:
        def __init__(self, keys):
            self.keys = keys
            self.pages = 0

        async def list(self, *, prefix, limit, cursor=None):
            self.pages += 1
            objects = [
                types.SimpleNamespace(
                    key=key,
                    size=1024,
                    uploaded=types.SimpleNamespace(getTime=lambda: 1_600_000_000_000),
                )
                for key in self.keys
                if key.startswith(prefix)
            ]
            return types.SimpleNamespace(objects=objects, truncated=False, cursor=None)

    def _scan(self, call, database=None, keys=None):
        bucket = self.Bucket(keys if keys is not None else [f"videos/{ASSET_ID}/9/master.m3u8"])
        return (
            call(
                signed_in("/api/video-storage/scan", "POST"),
                database=database,
                bucket=bucket,
                source_bucket=bucket,
                env={"VIDEO_UPLOAD_ENABLED": "1"},
            ),
            bucket,
        )

    def test_it_reports_what_nothing_accounts_for(self, call, database_of):
        database = database_of()

        response, _ = self._scan(call, database=database)

        assert response.status == 200
        assert response.json()["output"]["objects"] == 1
        recorded = [b for sql, b in database.writes if sql.startswith("INSERT INTO video_storage_orphans")]
        assert recorded and recorded[0][2] == f"videos/{ASSET_ID}/9/master.m3u8"

    def test_a_version_d1_records_is_not_reported(self, call, database_of):
        database = database_of(
            {
                "FROM video_encode_versions versions": [
                    {"asset_id": ASSET_ID, "encode_version": 9}
                ]
            }
        )

        response, _ = self._scan(call, database=database)

        assert response.json()["output"]["objects"] == 0

    def test_the_sweep_is_written_down_before_and_after(self, call, database_of):
        """A sweep that dies halfway leaves a row with no finish time, which is
        a fact worth having: the overview can say the last one did not complete
        rather than showing its half-counts as today's answer."""

        database = database_of()

        self._scan(call, database=database)

        statements = [sql for sql, _ in database.writes]
        assert any(sql.startswith("INSERT INTO video_storage_scans") for sql in statements)
        assert any(sql.startswith("UPDATE video_storage_scans SET finished_at") for sql in statements)

    def test_orphans_are_read_from_the_last_finished_sweep(self, call):
        response = call(
            signed_in("/api/video-storage/orphans?bucket=output"),
            {
                "FROM video_storage_scans WHERE finished_at IS NOT NULL": [
                    {
                        "id": "scan-1", "finished_at": 1785292800, "truncated": 0,
                        "source_orphan_bytes": 0, "source_orphan_objects": 0,
                        "output_orphan_bytes": 2048, "output_orphan_objects": 2,
                    }
                ],
                "FROM video_storage_orphans": [
                    {"object_key": "videos/x/9/master.m3u8", "byte_size": 2048, "uploaded_at": 1}
                ],
            },
        )

        assert response.status == 200
        assert response.json()["objects"][0]["size"] == 2048
        assert response.json()["scan"]["scannedAt"] == 1785292800

    def test_a_bucket_that_is_not_one_is_refused(self, call):
        assert call(signed_in("/api/video-storage/orphans?bucket=elsewhere")).status == 400

    def test_a_sweep_already_running_is_a_conflict(self, call, database_of):
        """Two sweeps are two full listings of both buckets, which is the exact
        cost this design spends once on purpose."""

        database = database_of(
            {"FROM video_storage_scans WHERE finished_at IS NULL": [{"id": "scan-0"}]}
        )

        response, _ = self._scan(call, database=database)

        assert response.status == 409

    def test_the_desktop_token_cannot_sweep(self):
        from domain import desktop_auth

        assert desktop_auth.scope_allows("video", "POST", "/api/video-storage/scan") is False


class TestOpeningASourceUpload:
    """The routes the tool drives a multipart upload of the original through.

    The parts are presigned URLs; opening and finishing the upload are requests
    to the Worker, because a pending multipart upload is state R2 holds for us
    and the row that remembers it is the only way to end it.
    """

    R2_ENV = {
        "R2_S3_ENDPOINT": "https://0123456789abcdef.r2.cloudflarestorage.com",
        "R2_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
        "R2_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "COURSE_SOURCE_BUCKET": "luma-course-source",
        "COURSE_VIDEO_BUCKET": "luma-course-video",
        "VIDEO_UPLOAD_ENABLED": "1",
    }

    def _session_row(self, **extra):
        return {
            "id": "session-1", "asset_id": ASSET_ID, "upload_id": "ABPnzm4-tEXAMPLE",
            "part_size": 64 * 1024 * 1024, "part_count": 64, "status": "uploading",
            "etag": None, "expires_at": 4102444800, "created_at": 0, "updated_at": 0,
            **extra,
        }

    def _r2(self, monkeypatch, upload_id="ABPnzm4-tEXAMPLE"):
        from shared import r2_s3

        async def fake_start(*, credentials, bucket, key, now):
            if isinstance(upload_id, Exception):
                raise upload_id
            return upload_id

        monkeypatch.setattr(r2_s3, "start_multipart", fake_start)

    def test_starting_one_says_how_to_cut_the_file(self, call, monkeypatch):
        self._r2(monkeypatch)

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload", "POST"),
            {"SELECT * FROM video_assets": [an_asset(status="uploading")]},
            env=self.R2_ENV,
        )

        assert response.status == 201
        body = response.json()
        assert body["partSize"] > 0 and body["partCount"] > 0 and body["sessionId"]

    def test_a_video_that_is_no_longer_uploading_is_refused(self, call, monkeypatch):
        self._r2(monkeypatch)

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload", "POST"),
            {"SELECT * FROM video_assets": [an_asset(status="ready")]},
            env=self.R2_ENV,
        )

        assert response.status == 409

    def test_r2_being_unreachable_is_not_reported_as_the_caller_s_fault(self, call, monkeypatch):
        from shared.r2_s3 import R2Error

        self._r2(monkeypatch, upload_id=R2Error("R2 could not be reached"))

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload", "POST"),
            {"SELECT * FROM video_assets": [an_asset(status="uploading")]},
            env=self.R2_ENV,
        )

        assert response.status == 502

    def test_an_unconfigured_deployment_says_so_rather_than_signing_nothing(self, call, monkeypatch):
        self._r2(monkeypatch)

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload", "POST"),
            {"SELECT * FROM video_assets": [an_asset(status="uploading")]},
            env={"VIDEO_UPLOAD_ENABLED": "1"},
        )

        assert response.status == 503

    def test_a_part_url_is_signed_for_that_part(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/parts/3", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 200
        assert "partNumber=3" in response.json()["url"]

    def test_a_part_past_the_end_of_the_file_is_refused(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/parts/999", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 400

    def test_an_unknown_session_is_not_found(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-9/parts/1", "POST"),
            {"SELECT * FROM video_assets": [an_asset(status="uploading")]},
            env=self.R2_ENV,
        )

        assert response.status == 404

    def test_signing_a_part_is_gated_by_the_same_switch(self, call):
        """Turning the flag off stops new sessions, and would otherwise leave the
        ones already open able to keep writing."""

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/parts/1", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env={**self.R2_ENV, "VIDEO_UPLOAD_ENABLED": "0"},
        )

        assert response.status == 403

    @pytest.mark.parametrize("segment", ["+1", " 1", "1e3", "٣", "0x1", "1.0"])
    def test_a_part_number_that_is_not_digits_is_refused_not_coerced(self, call, segment):
        """`int` accepts a leading plus, surrounding space and unicode digits.
        A path segment either is a part number or it is not one."""

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/parts/{segment}", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 400

    def test_a_session_that_already_ended_says_so_rather_than_400(self, call):
        """"This upload is over" and "that is not a part number" are different
        answers, and a caller cannot tell them apart from one status code."""

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/parts/1", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row(status="completed")],
            },
            env=self.R2_ENV,
        )

        assert response.status == 409

    def test_finishing_reports_the_assembled_object(self, call, monkeypatch):
        from shared import r2_s3

        async def fake_complete(*, credentials, bucket, key, upload_id, parts, now):
            return '"deadbeef-2"'

        monkeypatch.setattr(r2_s3, "complete_multipart", fake_complete)

        response = call(
            JsonRequest(
                f"/api/video-assets/{ASSET_ID}/source-upload/session-1/complete",
                "POST",
                {"parts": [{"partNumber": 1, "eTag": '"a"'}]},
                {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
            ),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 200
        assert response.json()["etag"] == '"deadbeef-2"'

    def test_r2_refusing_to_finish_is_not_the_caller_s_fault(self, call, monkeypatch):
        from shared import r2_s3

        async def fake_complete(*, credentials, bucket, key, upload_id, parts, now):
            raise r2_s3.R2Error("nope", status=500, code="InternalError")

        monkeypatch.setattr(r2_s3, "complete_multipart", fake_complete)

        response = call(
            JsonRequest(
                f"/api/video-assets/{ASSET_ID}/source-upload/session-1/complete",
                "POST",
                {"parts": [{"partNumber": 1, "eTag": '"a"'}]},
                {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
            ),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 502

    def test_cancelling_ends_the_session(self, call, monkeypatch):
        from shared import r2_s3

        cancelled: list[str] = []

        async def fake_abort(*, credentials, bucket, key, upload_id, now):
            cancelled.append(upload_id)

        monkeypatch.setattr(r2_s3, "abort_multipart", fake_abort)

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/abort", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 200
        assert cancelled == ["ABPnzm4-tEXAMPLE"]

    @pytest.mark.parametrize("path", ["complete/now", "abort/../archive", "parts"])
    def test_a_step_with_anything_after_it_is_not_found(self, call, path):
        """The step is the whole segment. Matching a prefix would make
        `.../complete/anything` a complete."""

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/{path}", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 404

    def test_an_unknown_step_is_not_found(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/finish", "POST"),
            {
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            },
            env=self.R2_ENV,
        )

        assert response.status == 404

    def test_the_session_is_read_with_its_asset(self, call):
        """A session id alone would let a token for one asset name a session
        belonging to another."""

        database = FakeDatabase(
            {
                **SIGNED_IN,
                "SELECT * FROM video_assets": [an_asset(status="uploading")],
                "SELECT * FROM video_upload_sessions": [self._session_row()],
            }
        )

        call(
            signed_in(f"/api/video-assets/{ASSET_ID}/source-upload/session-1/parts/1", "POST"),
            database=database,
            env=self.R2_ENV,
        )

        reads = [b for sql, b in database.reads if "FROM video_upload_sessions" in sql]
        assert reads and reads[0] == ("session-1", ASSET_ID)


class TestImporting:
    """Registering a ladder that was transcoded and uploaded elsewhere."""

    # What each stand-in object claims to weigh. Distinct numbers so a total
    # that double-counts or skips one is a different number, not the same one.
    HEAD_BYTES = 1_000_000

    class Bucket:
        def __init__(self, complete: bool = True, head_bytes: int = 1_000_000):
            self.complete = complete
            self.head_bytes = head_bytes

        async def get(self, key: str):
            if not key.endswith(".m3u8"):
                return None
            if key.endswith("master.m3u8"):
                body = "#EXTM3U\n720p/playlist.m3u8\n"
            else:
                body = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment-000001.m4s\n'

            class Stored:
                size = len(body)

                async def text(self_inner):
                    return body

            return Stored()

        async def head(self, key: str):
            if not self.complete:
                return None
            return types.SimpleNamespace(size=self.head_bytes)

    def _call(self, call, body: dict, *, complete: bool = True, answers: dict | None = None, database=None):
        return call(
            JsonRequest(
                "/api/video-assets/import",
                "POST",
                body,
                {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
            ),
            answers,
            bucket=self.Bucket(complete),
            database=database,
            # Registering is part of uploading, and the same switch gates it.
            env={"VIDEO_UPLOAD_ENABLED": "1"},
        )

    def test_a_complete_upload_becomes_playable(self, call):
        # The route reads the asset back before returning it.
        response = self._call(
            call, self._call_body(), answers={"SELECT * FROM video_assets": [an_asset()]}
        )

        assert response.status == 201
        assert response.json()["asset"]["status"] == "ready"

    def test_an_incomplete_upload_is_refused_and_says_what_is_missing(self, call):
        """The whole point of this endpoint. A ladder short one segment plays
        until it reaches it."""

        response = self._call(call, self._call_body(), complete=False)

        assert response.status == 409
        assert response.json()["missing"]

    def test_an_import_needs_a_title(self, call):
        response = self._call(call, {**self._call_body(), "title": "  "})

        assert response.status == 400

    @pytest.mark.parametrize("width", ["1920", 1920.0, True, []])
    def test_a_measurement_that_is_not_a_number_is_refused_not_dropped(self, call, width):
        """It used to be silently coerced to None. Discarding what a caller
        sent leaves them believing it was recorded — and `isinstance(True, int)`
        is true, so a naive check stored a width of 1."""

        response = self._call(call, {**self._call_body(), "width": width})

        assert response.status == 400

    def test_the_verified_version_is_recorded_with_what_it_occupies(self, call, database_of):
        """Asserted on the write, not on the asset the route reads back: the
        fake answers reads from the test's own fixture, so a read-back assertion
        would pass with no INSERT at all. This project has made that mistake
        four times.
        """

        database = database_of({"SELECT * FROM video_assets": [an_asset()]})

        self._call(call, self._call_body(), database=database)

        recorded = [
            bindings for sql, bindings in database.writes if "INSERT INTO video_encode_versions" in sql
        ]
        assert recorded, "a verified encode has to leave a row the storage page can add up"
        asset_id, version, objects, byte_size, has_poster, *_ = recorded[0]
        assert version == 1
        # master + 720p playlist walked, then init, segment and the poster HEADed.
        assert objects == 5
        # Three HEADed objects at a megabyte each, plus the two playlists whose
        # bodies were read: the playlists count too, they are objects in the bucket.
        assert byte_size == 3 * self.HEAD_BYTES + 27 + 53
        assert has_poster == 1
        assert isinstance(asset_id, str) and asset_id

    def test_the_version_is_recorded_before_the_asset_goes_live(self, call, database_of):
        """Two statements with no transaction between them, so the order decides
        what a failure between them leaves behind.

        Asset first: a `ready` asset whose `active_encode_version` names a version
        no row describes — which is exactly what the orphan scan will read as
        "these objects belong to nobody", about objects a member is watching.

        Version first: a row nothing live points at, which overstates a storage
        total by one encode until the next import fixes it. That is the direction
        to fail in.
        """

        database = database_of({"SELECT * FROM video_assets": [an_asset()]})

        self._call(call, self._call_body(), database=database)

        order = [
            sql
            for sql, _ in database.writes
            if sql.startswith("INSERT INTO video_encode_versions")
            or sql.startswith("INSERT INTO video_assets")
        ]
        assert order and order[0].startswith("INSERT INTO video_encode_versions")

    def test_an_incomplete_upload_records_no_version(self, call, database_of):
        """A version row is the claim "this encode is complete". Writing one for
        a ladder that is missing objects would make it invisible to the orphan
        scan while it is still broken."""

        database = database_of()

        self._call(call, self._call_body(), complete=False, database=database)

        assert not [sql for sql, _ in database.writes if "INSERT INTO video_encode_versions" in sql]

    @pytest.mark.parametrize("status", ["aborted", "archived"])
    def test_a_retired_asset_is_not_brought_back(self, call, database_of, status):
        """Import writes straight to `ready` — the one place the state machine is
        bypassed — so nothing else would stop it.

        The scenario is not hypothetical: abandoning an upload only changes a row,
        and the tool holding presigned URLs keeps going. It finishes, calls import
        with the same asset id, and the video an admin retired is playable again.
        """

        database = database_of({"SELECT * FROM video_assets": [an_asset(status=status)]})

        response = self._call(call, {**self._call_body(), "assetId": ASSET_ID}, database=database)

        assert response.status == 409
        assert not [sql for sql, _ in database.writes if sql.startswith("INSERT INTO video_assets")]

    def test_a_measurement_may_be_absent(self, call):
        """A source with no readable duration is still worth registering."""

        response = self._call(
            call,
            {"title": "第一課"},
            answers={"SELECT * FROM video_assets": [an_asset()]},
        )

        assert response.status == 201

    def _call_body(self) -> dict:
        return {
            "title": "第一課",
            "originalFilename": "lesson-01.mp4",
            "durationSeconds": 600,
            "width": 1920,
            "height": 1080,
        }


class TestCreatingAnAsset:
    """The row the desktop tool uploads into.

    It exists before any bytes do, because every presigned URL is scoped to an
    asset and a version — so there has to be an asset to scope them to. The row
    starts at `uploading` and only the import route can move it to `ready`.
    """

    def _request(self, body: dict) -> JsonRequest:
        return JsonRequest(
            "/api/video-assets", "POST", body,
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
        )

    def _body(self, **extra) -> dict:
        return {
            "title": "第一課 起稿",
            "originalFilename": "lesson-01.mp4",
            "byteSize": 4_000_000_000,
            "durationSeconds": 1830,
            "width": 3840,
            "height": 2160,
            **extra,
        }

    def _insert(self, database) -> tuple[str, tuple]:
        """The row that was written.

        Asserted against rather than the response body, because the route reads
        the asset back and a fake database answers that read with whatever the
        test declared — so a response assertion here would be checking the
        fixture, not the insert.
        """

        writes = [pair for pair in database.writes if "INSERT INTO video_assets" in pair[0]]
        assert len(writes) == 1, database.writes
        return writes[0]

    def test_it_starts_at_uploading(self, call, database_of):
        database = database_of()

        response = call(self._request(self._body()), database=database, env={"VIDEO_UPLOAD_ENABLED": "1"})

        assert response.status == 201
        statement, _ = self._insert(database)
        assert "'uploading'" in statement

    def test_it_writes_an_id_of_the_shape_object_keys_accept(self, call, database_of):
        """The id ends up in object keys, so a key builder has to accept it.
        A generated id that ASSET_ID_PATTERN rejects would fail at the first
        presign rather than here."""

        from domain import video

        database = database_of()
        call(self._request(self._body()), database=database, env={"VIDEO_UPLOAD_ENABLED": "1"})

        _, bindings = self._insert(database)
        assert video.ASSET_ID_PATTERN.fullmatch(bindings[0])

    def test_it_reports_the_versions_the_tool_builds_keys_from(self, call):
        """Otherwise the tool has to know that a first upload is version 1."""

        body = call(self._request(self._body()), env={"VIDEO_UPLOAD_ENABLED": "1"}).json()

        assert body["uploadVersion"] == 1
        assert body["encodeVersion"] == 1

    def test_the_original_lands_under_the_asset_not_the_filename(self, call, database_of):
        """A filename is attacker-controlled and occasionally an attempt to
        write somewhere else."""

        from domain import video

        database = database_of()
        call(self._request(self._body(originalFilename="../../etc/passwd")), database=database,
             env={"VIDEO_UPLOAD_ENABLED": "1"})

        _, bindings = self._insert(database)
        assert video.source_key(bindings[0], 1) in bindings
        assert not any("etc/passwd" in str(value) for value in bindings if value != "../../etc/passwd")

    def test_a_title_is_required(self, call):
        response = call(self._request(self._body(title="  ")), env={"VIDEO_UPLOAD_ENABLED": "1"})

        assert response.status == 400

    @pytest.mark.parametrize("size", [0, -1, "big", None, 21 * 1024 * 1024 * 1024 * 1024])
    def test_an_impossible_size_is_refused(self, call, size):
        """The ceiling is checked before the upload rather than during it."""

        response = call(self._request(self._body(byteSize=size)), env={"VIDEO_UPLOAD_ENABLED": "1"})

        assert response.status == 400

    def test_the_dimensions_the_tool_reports_are_optional(self, call):
        """They come from the tool's ffprobe and are for display. Whether the
        encode is playable is decided by verifying objects, not by these."""

        response = call(
            self._request({"title": "第一課", "byteSize": 1_000_000}),
            env={"VIDEO_UPLOAD_ENABLED": "1"},
        )

        assert response.status == 201

    def test_nobody_creates_an_asset_while_uploading_is_switched_off(self, call):
        """Unset is off, and the switch is here rather than only in the front
        end — hiding a button leaves the endpoint open."""

        response = call(self._request(self._body()))

        assert response.status == 403

    def test_an_anonymous_caller_cannot_create_one(self, call):
        request = JsonRequest(
            "/api/video-assets", "POST", self._body(),
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"},
        )

        response = call(request, answers={"SELECT email FROM admin_sessions": []},
                        env={"VIDEO_UPLOAD_ENABLED": "1"})

        assert response.status == 401


R2_CONFIG = {
    "VIDEO_UPLOAD_ENABLED": "1",
    "R2_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
    "R2_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "COURSE_SOURCE_BUCKET": "luma-course-source",
    "COURSE_VIDEO_BUCKET": "luma-course-video",
}


def without(*names: str) -> dict:
    return {key: value for key, value in R2_CONFIG.items() if key not in names}


class TestHandingOutUploadUrls:
    """The only thing the desktop tool can do to a bucket.

    It holds no R2 key, so every write it makes is a URL granted here. Which
    makes this route the place where "one object, this asset, this version" is
    enforced, and a mistake in it is not a bug in a feature — it is the
    boundary being absent.
    """

    def _request(self, body: dict, asset_id: str = ASSET_ID) -> JsonRequest:
        return JsonRequest(
            f"/api/video-assets/{asset_id}/upload-urls", "POST", body,
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
        )

    def _uploading(self) -> dict:
        return {
            "SELECT * FROM video_assets": [
                an_asset(status="uploading", active_encode_version=None)
            ]
        }

    def _outputs(self, *names: str) -> list[str]:
        return [f"videos/{ASSET_ID}/1/{name}" for name in names]

    def _segments(self, count: int) -> list[str]:
        return self._outputs(*[f"720p/segment-{index:06d}.m4s" for index in range(count)])

    def test_each_key_comes_back_with_a_signed_url(self, call):
        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8", "720p/init.mp4")}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert response.status == 200
        urls = response.json()["urls"]
        assert [entry["key"] for entry in urls] == self._outputs("master.m3u8", "720p/init.mp4")
        assert all("X-Amz-Signature=" in entry["url"] for entry in urls)
        assert all(entry["expiresAt"] > 0 for entry in urls)

    def test_an_output_url_points_at_the_output_bucket(self, call):
        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8")}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert "/luma-course-video/" in response.json()["urls"][0]["url"]

    def test_a_source_url_points_at_the_source_bucket(self, call):
        """`kind` picks the bucket. Getting it wrong would put an original in
        the bucket the playback gateway reads from."""

        from domain import video

        response = call(
            self._request({"kind": "source", "keys": [video.source_key(ASSET_ID, 1)]}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert "/luma-course-source/" in response.json()["urls"][0]["url"]

    def test_the_url_is_signed_for_a_put_and_nothing_else(self, call):
        """A GET signed here would hand out the ability to read originals, which
        is a different grant and belongs to re-encoding.

        The method is part of the signature, so the only way to check is to
        re-sign the same request and compare.
        """

        from shared import sigv4
        from urllib.parse import parse_qs, urlparse

        key = self._outputs("master.m3u8")[0]
        response = call(
            self._request({"kind": "output", "keys": [key]}), self._uploading(), env=R2_CONFIG
        )
        granted = urlparse(response.json()["urls"][0]["url"])
        signature = parse_qs(granted.query)["X-Amz-Signature"][0]
        instant = int(
            __import__("datetime").datetime.strptime(
                parse_qs(granted.query)["X-Amz-Date"][0], "%Y%m%dT%H%M%SZ"
            ).replace(tzinfo=__import__("datetime").timezone.utc).timestamp()
        )
        expires = int(parse_qs(granted.query)["X-Amz-Expires"][0])

        def resign(method: str) -> str:
            url = sigv4.presigned_url(
                method=method,
                endpoint=R2_CONFIG["R2_S3_ENDPOINT"],
                bucket="luma-course-video",
                key=key,
                access_key_id=R2_CONFIG["R2_ACCESS_KEY_ID"],
                secret_access_key=R2_CONFIG["R2_SECRET_ACCESS_KEY"],
                now=instant,
                expires=expires,
            )
            return parse_qs(urlparse(url).query)["X-Amz-Signature"][0]

        assert signature == resign("PUT")
        assert signature != resign("GET")

    def test_a_key_belonging_to_another_asset_is_refused(self, call):
        """The refusal that matters most: one upload writing into another
        video."""

        response = call(
            self._request({"kind": "output", "keys": ["videos/asset-999999/1/master.m3u8"]}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert response.status == 400

    def test_a_key_for_another_version_is_refused(self, call):
        """Claiming to upload a new encode while writing into the one members
        are watching."""

        response = call(
            self._request({"kind": "output", "encodeVersion": 2, "keys": self._outputs("master.m3u8")}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert response.status == 400

    @pytest.mark.parametrize(
        "key",
        [
            "videos/asset-000001/1/../../sources/asset-000001/1/source.mp4",
            "videos/asset-000001/1/notes.txt",
            "sources/asset-000001/1/source.mp4",
            "/videos/asset-000001/1/master.m3u8",
            "videos/asset-000001/1/",
            "",
        ],
    )
    def test_anything_that_is_not_part_of_this_encode_is_refused(self, call, key):
        response = call(
            self._request({"kind": "output", "keys": [key]}), self._uploading(), env=R2_CONFIG
        )

        assert response.status == 400

    def test_one_bad_key_refuses_the_whole_batch(self, call):
        """Signing the good ones would leave the tool believing it had URLs for
        everything it asked about."""

        keys = [*self._outputs("master.m3u8"), "videos/asset-999999/1/master.m3u8"]

        response = call(self._request({"kind": "output", "keys": keys}), self._uploading(), env=R2_CONFIG)

        assert response.status == 400

    def test_an_unknown_kind_is_refused(self, call):
        response = call(
            self._request({"kind": "anything", "keys": self._outputs("master.m3u8")}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert response.status == 400

    def test_asking_for_no_keys_is_refused(self, call):
        response = call(self._request({"kind": "output", "keys": []}), self._uploading(), env=R2_CONFIG)

        assert response.status == 400

    def test_asking_for_too_many_at_once_is_refused(self, call):
        """One request must not turn into thousands of live credentials."""

        from domain import video_storage

        response = call(
            self._request({"kind": "output", "keys": self._segments(video_storage.MAX_URLS + 1)}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert response.status == 400

    def test_a_batch_at_the_limit_is_allowed(self, call):
        from domain import video_storage

        response = call(
            self._request({"kind": "output", "keys": self._segments(video_storage.MAX_URLS)}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert response.status == 200

    def test_an_asset_that_does_not_exist_is_not_found(self, call):
        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8")}), env=R2_CONFIG
        )

        assert response.status == 404

    def test_an_asset_that_is_no_longer_uploading_is_refused(self, call):
        """A ready asset's objects are what members are watching. Handing out
        write URLs for them would let a stray retry overwrite a live encode."""

        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8")}),
            {"SELECT * FROM video_assets": [an_asset(status="ready")]},
            env=R2_CONFIG,
        )

        assert response.status == 409

    def test_nothing_is_signed_while_uploading_is_switched_off(self, call):
        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8")}),
            self._uploading(),
            env=without("VIDEO_UPLOAD_ENABLED"),
        )

        assert response.status == 403

    def test_an_anonymous_caller_gets_no_url(self, call):
        request = JsonRequest(
            f"/api/video-assets/{ASSET_ID}/upload-urls", "POST",
            {"kind": "output", "keys": self._outputs("master.m3u8")},
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"},
        )

        response = call(request, answers={"SELECT email FROM admin_sessions": []}, env=R2_CONFIG)

        assert response.status == 401

    @pytest.mark.parametrize("missing", ["R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])
    def test_an_unconfigured_worker_says_so_rather_than_signing_nothing(self, call, missing):
        """An unsigned URL that looks signed reaches R2, fails there, and the
        log says nothing about why. 503 rather than 400: the caller did nothing
        wrong."""

        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8")}),
            self._uploading(),
            env=without(missing),
        )

        assert response.status == 503

    def test_the_response_never_carries_the_secret(self, call):
        response = call(
            self._request({"kind": "output", "keys": self._outputs("master.m3u8")}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert R2_CONFIG["R2_SECRET_ACCESS_KEY"] not in response.body

    def test_a_refusal_does_not_echo_a_signed_url(self, call):
        """Error paths are where credentials leak, because nobody reads them."""

        response = call(
            self._request({"kind": "output", "keys": ["videos/asset-999999/1/master.m3u8"]}),
            self._uploading(),
            env=R2_CONFIG,
        )

        assert "X-Amz-Signature" not in response.body
