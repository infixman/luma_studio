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


class SourceBucket:
    """Enough of the R2 binding to answer "is the assembled object there"."""

    def __init__(self, stored=None):
        self.stored = stored
        self.asked: list[str] = []

    async def head(self, key: str):
        import types

        self.asked.append(key)
        return None if self.stored is None else types.SimpleNamespace(**self.stored)


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

    @pytest.mark.parametrize("status", ["uploading", "completed"])
    def test_a_second_session_for_one_asset_is_refused(self, source_upload, monkeypatch, status):
        """Every session for an asset writes the same key, and `complete` treats
        an object at that key as evidence its own upload finished. A second
        session would let the first one's object answer for it."""

        started(source_upload, monkeypatch)
        env = env_with({"FROM video_upload_sessions WHERE asset_id": [{"id": "session-0", "status": status}]})

        with pytest.raises(ValueError):
            self._start(source_upload, env)

    def test_a_cancelled_session_does_not_block_trying_again(self, source_upload, monkeypatch):
        started(source_upload, monkeypatch)
        env = env_with({"FROM video_upload_sessions WHERE asset_id": []})

        assert self._start(source_upload, env)["sessionId"]

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


class TestFinishing:
    """Completing is the step that cannot be made idempotent by asking R2.

    A finished upload's id stops existing, so a second complete and a complete of
    something that never existed both answer `NoSuchUpload`. The row is what
    tells them apart — and when the row does not know either, because the answer
    to the first attempt was lost, the object itself is the evidence.
    """

    def _completing(self, source_upload, monkeypatch, result):
        calls: list[dict] = []

        async def fake_complete(*, credentials, bucket, key, upload_id, parts, now):
            calls.append({"key": key, "upload_id": upload_id, "parts": list(parts)})
            if isinstance(result, Exception):
                raise result
            return result

        monkeypatch.setattr(source_upload.r2_s3, "complete_multipart", fake_complete)
        return calls

    def _env(self, answers=None, stored=None):
        env = env_with(answers)
        env.COURSE_SOURCE = SourceBucket(stored)
        return env

    def _complete(self, source_upload, env, session=None, parts=None, now=1785292800, asset=None):
        return asyncio.run(
            source_upload.complete(
                env,
                asset=asset or an_asset(),
                session=session or a_session(),
                parts=parts if parts is not None else [{"partNumber": 1, "eTag": '"abc"'}],
                now=now,
            )
        )

    def test_it_assembles_the_object_and_records_the_tag(self, source_upload, monkeypatch):
        self._completing(source_upload, monkeypatch, '"deadbeef-2"')
        env = self._env()

        finished = self._complete(source_upload, env)

        assert finished["etag"] == '"deadbeef-2"'
        writes = [b for sql, b in env.DB.writes if sql.startswith("UPDATE video_upload_sessions")]
        assert writes and "completed" in writes[0] and '"deadbeef-2"' in writes[0]

    def test_the_parts_the_tool_reports_are_what_is_sent(self, source_upload, monkeypatch):
        calls = self._completing(source_upload, monkeypatch, '"x"')

        self._complete(
            source_upload,
            self._env(),
            parts=[{"partNumber": 2, "eTag": '"b"'}, {"partNumber": 1, "eTag": '"a"'}],
        )

        assert sorted(calls[0]["parts"]) == [(1, '"a"'), (2, '"b"')]

    def test_completing_again_answers_from_the_row_without_asking_r2(self, source_upload, monkeypatch):
        """The tool retrying after a lost answer is the ordinary path, and asking
        R2 again would get `NoSuchUpload` for an upload that worked."""

        calls = self._completing(source_upload, monkeypatch, '"x"')

        finished = self._complete(
            source_upload, self._env(), session=a_session(status="completed", etag='"deadbeef-2"')
        )

        assert finished["etag"] == '"deadbeef-2"'
        assert calls == []

    def test_completing_an_upload_whose_video_was_retired_is_refused(self, source_upload, monkeypatch):
        """An admin abandoned it while the tool was still pushing parts. Writing
        the original of a retired video records something nothing will read."""

        self._completing(source_upload, monkeypatch, '"x"')

        with pytest.raises(ValueError):
            self._complete(source_upload, self._env(), asset=an_asset(status="aborted"))

    def test_a_session_somebody_else_already_ended_is_reported_not_overwritten(
        self, source_upload, monkeypatch
    ):
        """A tool completing while an admin cancels is one request per outcome.
        The one whose UPDATE changes nothing must not report its own."""

        self._completing(source_upload, monkeypatch, '"x"')
        env = self._env()
        env.DB.changes = {"UPDATE video_upload_sessions": 0}

        with pytest.raises(ValueError):
            self._complete(source_upload, env)

    def test_completing_an_abandoned_upload_is_refused(self, source_upload, monkeypatch):
        self._completing(source_upload, monkeypatch, '"x"')

        with pytest.raises(ValueError):
            self._complete(source_upload, self._env(), session=a_session(status="aborted"))

    def test_an_upload_r2_has_no_record_of_is_settled_by_looking_at_the_object(
        self, source_upload, monkeypatch
    ):
        """The case that matters: R2 assembled the object and the answer never
        arrived. Asking again says `NoSuchUpload`, which is the same thing it
        says about an id that never existed — so the object decides."""

        from shared.r2_s3 import R2Error

        self._completing(source_upload, monkeypatch, R2Error("gone", status=404, code="NoSuchUpload"))
        env = self._env(stored={"size": 4096, "etag": '"deadbeef-2"'})

        finished = self._complete(source_upload, env)

        assert finished["etag"] == '"deadbeef-2"'
        writes = [b for sql, b in env.DB.writes if sql.startswith("UPDATE video_upload_sessions")]
        assert writes and "completed" in writes[0]

    def test_an_upload_r2_has_no_record_of_and_no_object_for_is_a_failure(
        self, source_upload, monkeypatch
    ):
        from shared.r2_s3 import R2Error

        self._completing(source_upload, monkeypatch, R2Error("gone", status=404, code="NoSuchUpload"))
        env = self._env(stored=None)

        with pytest.raises(R2Error):
            self._complete(source_upload, env)

        assert not [sql for sql, _ in env.DB.writes if sql.startswith("UPDATE video_upload_sessions")]

    def test_any_other_refusal_is_not_reinterpreted(self, source_upload, monkeypatch):
        from shared.r2_s3 import R2Error

        self._completing(source_upload, monkeypatch, R2Error("nope", status=403, code="AccessDenied"))

        with pytest.raises(R2Error):
            self._complete(source_upload, self._env(stored={"size": 4096, "etag": '"x"'}))

    @pytest.mark.parametrize(
        "parts",
        [
            [],
            [{"partNumber": "1", "eTag": '"a"'}],
            [{"partNumber": 1}],
            [{"eTag": '"a"'}],
            "not a list",
        ],
    )
    def test_a_part_list_that_is_not_one_is_refused(self, source_upload, monkeypatch, parts):
        self._completing(source_upload, monkeypatch, '"x"')

        with pytest.raises(ValueError):
            self._complete(source_upload, self._env(), parts=parts)


class TestCancelling:
    def _cancelling(self, source_upload, monkeypatch, error=None):
        calls: list[dict] = []

        async def fake_abort(*, credentials, bucket, key, upload_id, now):
            calls.append({"key": key, "upload_id": upload_id})
            if error is not None:
                raise error

        monkeypatch.setattr(source_upload.r2_s3, "abort_multipart", fake_abort)
        return calls

    def _abort(self, source_upload, env, session=None, now=1785292800):
        return asyncio.run(source_upload.abort(env, session=session or a_session(), now=now))

    def test_it_cancels_the_upload_and_marks_the_row(self, source_upload, monkeypatch):
        calls = self._cancelling(source_upload, monkeypatch)
        env = env_with()

        self._abort(source_upload, env)

        assert calls and calls[0]["upload_id"] == UPLOAD_ID
        writes = [b for sql, b in env.DB.writes if sql.startswith("UPDATE video_upload_sessions")]
        assert writes and "aborted" in writes[0]

    def test_cancelling_twice_is_not_an_error(self, source_upload, monkeypatch):
        calls = self._cancelling(source_upload, monkeypatch)

        self._abort(source_upload, env_with(), session=a_session(status="aborted"))

        assert calls == []

    def test_an_expired_session_can_still_be_cancelled(self, source_upload, monkeypatch):
        """The row's window is over; the pending upload in R2 is not. Refusing
        here would leave the only thing that can end it unreachable."""

        calls = self._cancelling(source_upload, monkeypatch)

        self._abort(source_upload, env_with(), session=a_session(expires_at=1785292799))

        assert calls

    def test_cancelling_a_finished_upload_is_refused(self, source_upload, monkeypatch):
        """The object exists and is the asset's original. "Cancel" would either
        do nothing or delete it, and neither is what the word says."""

        self._cancelling(source_upload, monkeypatch)

        with pytest.raises(ValueError):
            self._abort(source_upload, env_with(), session=a_session(status="completed"))
