"""Opening a multipart upload for an original file, and signing its parts.

A 4K lesson is several gigabytes. A single PUT that dies at 87% starts again at
zero, so the original goes up in parts — and unlike the HLS objects, the parts of
one object are not independent: R2 holds a pending upload open until somebody
completes or cancels it, and one that is never finished is billed storage nobody
can see.

That is what the session row is for, and why starting one is a thing the server
does rather than a URL the tool is handed.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


ASSET_ID = "asset-000001"
UPLOAD_ID = "ABPnzm4-tEXAMPLE"
CREDENTIALS_ENV = {
    "R2_S3_ENDPOINT": "https://0123456789abcdef.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
    "R2_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "COURSE_SOURCE_BUCKET": "luma-course-source",
    "COURSE_VIDEO_BUCKET": "luma-course-video",
}

GIGABYTE = 1024 * 1024 * 1024


@pytest.fixture
def source_upload():
    from domain import source_upload as module

    return module


def an_asset(**extra) -> dict:
    return {
        "id": ASSET_ID,
        "title": "第一課",
        "originalFilename": "lesson-01.mp4",
        "status": "uploading",
        "byteSize": 4 * GIGABYTE,
        "durationSeconds": 1830,
        "width": 3840,
        "height": 2160,
        "encodeVersion": None,
        "hasPoster": False,
        "errorCode": None,
        "errorDetail": None,
        "createdAt": 0,
        "updatedAt": 0,
        **extra,
    }


def env_with(answers=None, changes=None):
    return make_env(FakeDatabase(answers or {}, changes=changes), **CREDENTIALS_ENV)


def started(source_upload, monkeypatch, upload_id=UPLOAD_ID):
    """R2 answers `create` with an upload id, without a network."""

    calls: list[dict] = []

    async def fake_start(*, credentials, bucket, key, now):
        calls.append({"bucket": bucket, "key": key, "now": now})
        if isinstance(upload_id, Exception):
            raise upload_id
        return upload_id

    monkeypatch.setattr(source_upload.r2_s3, "start_multipart", fake_start)
    return calls


class TestOpeningASession:
    def _start(self, source_upload, env, asset=None, now=1785292800):
        return asyncio.run(source_upload.start(env, asset=asset or an_asset(), now=now))

    def test_it_reports_how_the_tool_should_cut_the_file(self, source_upload, monkeypatch):
        started(source_upload, monkeypatch)
        env = env_with()

        session = self._start(source_upload, env)

        from domain import video

        assert session["partSize"] == video.part_size_for(4 * GIGABYTE)
        assert session["partCount"] == video.part_count_for(4 * GIGABYTE, session["partSize"])
        assert session["sessionId"]

    def test_the_upload_id_r2_issued_is_recorded(self, source_upload, monkeypatch):
        """Asserted on the INSERT rather than on what the route reads back: the
        fake answers reads from the test's own fixture, and this is the one value
        nothing else can reconstruct — without it the pending upload can never be
        completed or cancelled."""

        started(source_upload, monkeypatch)
        env = env_with()

        self._start(source_upload, env)

        writes = [b for sql, b in env.DB.writes if sql.startswith("INSERT INTO video_upload_sessions")]
        assert writes and UPLOAD_ID in writes[0]

    def test_it_asks_r2_for_this_asset_s_own_source_key(self, source_upload, monkeypatch):
        calls = started(source_upload, monkeypatch)
        env = env_with()

        self._start(source_upload, env)

        assert calls[0]["key"] == f"sources/{ASSET_ID}/1/source.mp4"
        assert calls[0]["bucket"] == "luma-course-source"

    def test_a_video_that_is_no_longer_uploading_is_refused(self, source_upload, monkeypatch):
        """Its source object is the one a re-encode would read. Opening a write
        session over it is how a `ready` asset loses its original."""

        started(source_upload, monkeypatch)

        with pytest.raises(ValueError):
            self._start(source_upload, env_with(), asset=an_asset(status="ready"))

    def test_too_many_pending_uploads_at_once_is_refused(self, source_upload, monkeypatch):
        """Every open session is a pending multipart upload in R2, billed and
        invisible. The limit is what stops a retry loop from opening hundreds."""

        started(source_upload, monkeypatch)
        env = env_with({"SELECT COUNT(*) AS live FROM video_upload_sessions": [{"live": source_upload.MAX_LIVE_SESSIONS}]})

        with pytest.raises(ValueError):
            self._start(source_upload, env)

    def test_nothing_is_recorded_when_r2_refuses(self, source_upload, monkeypatch):
        """A session row without a real upload behind it is a row whose complete
        and abort can never succeed."""

        from shared.r2_s3 import R2Error

        started(source_upload, monkeypatch, upload_id=R2Error("nope"))
        env = env_with()

        with pytest.raises(R2Error):
            self._start(source_upload, env)

        assert not [sql for sql, _ in env.DB.writes if sql.startswith("INSERT INTO video_upload_sessions")]

    def test_the_session_expires(self, source_upload, monkeypatch):
        started(source_upload, monkeypatch)

        session = self._start(source_upload, env_with(), now=1785292800)

        assert session["expiresAt"] == 1785292800 + source_upload.SESSION_TTL


def a_session(**extra) -> dict:
    return {
        "id": "session-1",
        "asset_id": ASSET_ID,
        "upload_id": UPLOAD_ID,
        "part_size": 64 * 1024 * 1024,
        "part_count": 64,
        "status": "uploading",
        "etag": None,
        "expires_at": 1785292800 + 3600,
        "created_at": 1785292800,
        "updated_at": 1785292800,
        **extra,
    }


class TestSigningAPart:
    def _url(self, source_upload, env=None, session=None, part_number=1, now=1785292800, asset=None):
        return source_upload.part_url(
            env or env_with(),
            asset=asset or an_asset(),
            session=session or a_session(),
            part_number=part_number,
            now=now,
        )

    def test_an_asset_that_was_retired_mid_upload_signs_nothing(self, source_upload):
        """Abandoning an upload retires the asset, not the session row. Without
        this the tool would go on writing into the original of a video the back
        office has finished with."""

        with pytest.raises(ValueError):
            self._url(source_upload, asset=an_asset(status="aborted"))

    def test_it_signs_a_put_for_that_part_of_that_upload(self, source_upload):
        granted = self._url(source_upload, part_number=7)

        assert "partNumber=7" in granted["url"]
        assert f"uploadId={UPLOAD_ID}" in granted["url"]
        assert "X-Amz-Signature=" in granted["url"]

    def test_the_url_is_for_the_source_object_of_that_asset(self, source_upload):
        granted = self._url(source_upload)

        assert f"/luma-course-source/sources/{ASSET_ID}/1/source.mp4?" in granted["url"]

    def test_a_part_beyond_the_end_of_the_file_is_refused(self, source_upload):
        """The part count comes from the size the asset was created with. A part
        past it is either a bug in the tool or an attempt to write more than the
        file it declared."""

        with pytest.raises(ValueError):
            self._url(source_upload, part_number=65)

    @pytest.mark.parametrize("part_number", [0, -1, "3", True])
    def test_an_impossible_part_number_is_refused(self, source_upload, part_number):
        with pytest.raises(ValueError):
            self._url(source_upload, part_number=part_number)

    def test_an_expired_session_signs_nothing(self, source_upload):
        """R2 keeps the pending upload, but this session's own window is over —
        and a session nobody is bounded by is the thing the expiry exists for."""

        with pytest.raises(ValueError):
            self._url(source_upload, session=a_session(expires_at=1785292799), now=1785292800)

    @pytest.mark.parametrize("status", ["completed", "aborted"])
    def test_a_finished_session_signs_nothing(self, source_upload, status):
        with pytest.raises(ValueError):
            self._url(source_upload, session=a_session(status=status))
