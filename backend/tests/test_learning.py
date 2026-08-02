"""What a member can reach, and what everybody else cannot.

Every route here answers from the session's own customer id. A request that
names a customer is a request to read somebody else's courses, so none of
these take one.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def learning():
    from domain import learning as module

    return module


def entitlement_row(**extra) -> dict:
    return {
        "id": "ent-1", "customer_id": "cust-1", "course_id": "course-1", "granted_at": 0,
        "access_days": None, "first_viewed_at": None, "expires_at": None,
        "revoked_at": None, "revoke_reason": None, "created_at": 0, "updated_at": 0,
        **extra,
    }


def lesson_row(**extra) -> dict:
    return {
        "id": "lesson-1", "section_id": "s1", "title": "工具介紹", "content_html": "<p>你好</p>",
        "video_asset_id": "asset-1", "is_preview": 0, "position": 0,
        **extra,
    }


class TestReachingALesson:
    def _database(self, *, entitlements=None, lessons=None, assets=None, course=None):
        return FakeDatabase(
            {
                "SELECT * FROM course_entitlements": entitlements if entitlements is not None else [entitlement_row()],
                "SELECT * FROM course_lessons": lessons if lessons is not None else [lesson_row()],
                "SELECT * FROM video_assets": assets if assets is not None else [{
                    "id": "asset-1", "title": "第一課", "original_filename": "a.mp4",
                    "source_key": "", "status": "ready", "byte_size": 1, "duration_seconds": 600,
                    "width": 1920, "height": 1080, "active_encode_version": 1,
                    "master_key": "videos/asset-1/1/master.m3u8", "poster_key": None,
                    "error_code": None, "error_detail": None, "created_at": 0, "updated_at": 0,
                }],
                # The course is reached through its section, so the fixture
                # has to answer the query the code actually makes.
                "FROM courses c JOIN course_sections": course if course is not None else [{
                    "id": "course-1", "slug": "watercolour", "title": "水彩入門", "status": "published",
                    "created_at": 0, "updated_at": 0,
                }],
            }
        )

    def _grant(self, env, learning, lesson_id="lesson-1"):
        return asyncio.run(learning.playable(env, customer_id="cust-1", lesson_id=lesson_id))

    def test_a_member_who_bought_the_course_may_watch(self, learning):
        result = self._grant(make_env(self._database()), learning)

        assert result["allowed"] is True
        assert result["assetId"] == "asset-1"
        assert result["encodeVersion"] == 1

    def test_a_member_who_did_not_may_not(self, learning):
        result = self._grant(make_env(self._database(entitlements=[])), learning)

        assert result["allowed"] is False
        assert result["reason"] == "not_entitled"

    def test_a_revoked_grant_does_not_let_somebody_back_in(self, learning):
        result = self._grant(make_env(self._database(entitlements=[entitlement_row(revoked_at=900)])), learning)

        assert result["allowed"] is False

    def test_an_expired_grant_does_not_either(self, learning):
        result = self._grant(
            make_env(self._database(entitlements=[entitlement_row(access_days=30, first_viewed_at=1, expires_at=2)])),
            learning,
        )

        assert result["allowed"] is False
        assert result["reason"] == "expired"

    def test_a_preview_lesson_is_open_to_anybody(self, learning):
        """Trying before buying is the point of a preview."""

        result = self._grant(
            make_env(self._database(entitlements=[], lessons=[lesson_row(is_preview=1)])), learning
        )

        assert result["allowed"] is True
        assert result["scope"] == "preview"

    def test_a_lesson_that_is_not_a_preview_is_not_opened_by_asking_nicely(self, learning):
        result = self._grant(make_env(self._database(entitlements=[])), learning)

        assert result["allowed"] is False

    def test_a_lesson_whose_video_is_not_ready_is_refused(self, learning):
        """Better a clear "not yet" than a player failing on a 404."""

        assets = [{
            "id": "asset-1", "title": "第一課", "original_filename": "a.mp4", "source_key": "",
            "status": "processing", "byte_size": 1, "duration_seconds": None, "width": None,
            "height": None, "active_encode_version": None, "master_key": None, "poster_key": None,
            "error_code": None, "error_detail": None, "created_at": 0, "updated_at": 0,
        }]
        result = self._grant(make_env(self._database(assets=assets)), learning)

        assert result["allowed"] is False
        assert result["reason"] == "not_ready"

    def test_a_reading_has_nothing_to_play(self, learning):
        result = self._grant(make_env(self._database(lessons=[lesson_row(video_asset_id=None)])), learning)

        assert result["allowed"] is False
        assert result["reason"] == "no_video"

    def test_a_lesson_nobody_has_is_not_found(self, learning):
        result = self._grant(make_env(self._database(lessons=[])), learning)

        assert result["allowed"] is False
        assert result["reason"] == "not_found"


class TestProgress:
    def test_a_position_is_written_against_the_session_member_only(self, learning):
        database = FakeDatabase()

        asyncio.run(
            learning.save_progress(
                make_env(database), customer_id="cust-1", course_id="c1", lesson_id="l1",
                position_seconds=480, completed=False,
            )
        )

        statement, bindings = database.writes[0]
        assert "cust-1" in bindings
        assert "INSERT INTO course_lesson_progress" in statement

    @pytest.mark.parametrize("value", [-1, 1.5, "480", True, None])
    def test_a_position_that_is_not_a_whole_number_of_seconds_is_refused(self, learning, value):
        with pytest.raises(ValueError):
            asyncio.run(
                learning.save_progress(
                    make_env(FakeDatabase()), customer_id="cust-1", course_id="c1", lesson_id="l1",
                    position_seconds=value, completed=False,
                )
            )

    def test_a_position_beyond_any_plausible_lesson_is_refused(self, learning):
        """Not a limit on lessons — a number past this is a broken client."""

        with pytest.raises(ValueError):
            asyncio.run(
                learning.save_progress(
                    make_env(FakeDatabase()), customer_id="cust-1", course_id="c1", lesson_id="l1",
                    position_seconds=learning.MAX_POSITION_SECONDS + 1, completed=False,
                )
            )

    def test_marking_complete_records_when(self, learning):
        database = FakeDatabase()

        asyncio.run(
            learning.save_progress(
                make_env(database), customer_id="cust-1", course_id="c1", lesson_id="l1",
                position_seconds=600, completed=True,
            )
        )

        statement, _ = database.writes[0]
        assert "completed_at" in statement

    def test_rewatching_a_finished_lesson_does_not_unfinish_it(self, learning):
        """Scrubbing back to the start is not un-completing."""

        database = FakeDatabase()

        asyncio.run(
            learning.save_progress(
                make_env(database), customer_id="cust-1", course_id="c1", lesson_id="l1",
                position_seconds=10, completed=False,
            )
        )

        statement, _ = database.writes[0]
        assert "COALESCE(course_lesson_progress.completed_at" in statement


class TestStartingALesson:
    """The route that hands out the token everything else depends on.

    It had no test at all until the byte-serving was split into its own module
    and this route was left calling a helper that had moved — a `NameError` on
    every member pressing play, with the whole suite green. The gateway half was
    covered; the half that mints what the gateway checks was not.
    """

    @pytest.fixture
    def call(self):
        import main
        from shared import migrations

        def run(database, **extra):
            migrations._applied_names = None
            worker = main.Default()
            worker.env = make_env(database, **extra)
            from conftest import FakeRequest, STOREFRONT_ORIGIN

            return asyncio.run(
                worker.fetch(
                    FakeRequest(
                        "/api/learning/lessons/lesson-1/playback-session",
                        "POST",
                        {
                            "Origin": STOREFRONT_ORIGIN,
                            "x-luma-app": "1",
                            "Cookie": "luma_customer_session=" + "a" * 40,
                        },
                    )
                )
            )

        return run

    def _database(self) -> FakeDatabase:
        member = TestReachingALesson()._database()
        member.answers["FROM customer_sessions s JOIN customers c"] = [
            {
                "id": "cust-1", "google_sub": "g-1", "email": "a@example.com",
                "display_name": "王小明", "default_recipient_name": "王小明",
                "default_recipient_phone": "0912345678", "default_address": "台北市",
                "blocked": 0, "account_blocked": 0, "anonymized_at": None,
                "created_at": 0, "updated_at": 0,
            }
        ]
        return member

    def test_a_member_who_owns_the_course_is_told_where_to_point_the_player(self, call):
        response = call(self._database(), PLAYBACK_SECRET="a-signing-key")

        assert response.status == 200
        assert response.json()["playbackUrl"] == "/course-media/asset-1/1/master.m3u8"
        assert "Path=/course-media/asset-1/1/" in response.headers["set-cookie"]

    def test_it_says_when_the_session_runs_out(self, call):
        """The page renews on this. An expiry already in the past is a page
        that renews in a loop; one too far out is a player refused mid-lesson
        with nothing scheduled to fix it."""

        from domain import playback
        from shared.common import utc_timestamp

        response = call(self._database(), PLAYBACK_SECRET="a-signing-key")

        # A second of slack: the timestamp is taken inside the request.
        assert abs(response.json()["expiresAt"] - (utc_timestamp() + playback.DEFAULT_TTL)) <= 1

    def test_the_cookie_it_hands_back_opens_that_lesson(self, call):
        """The two halves pass separately while naming different things, which
        would be a session that mints a perfectly good token and then refuses
        it. Only using one proves they agree."""

        import main
        from conftest import FakeRequest, STOREFRONT_ORIGIN
        from shared import migrations

        minted = call(self._database(), PLAYBACK_SECRET="a-signing-key")
        cookie = minted.headers["set-cookie"].split(";")[0]

        class Bucket:
            def __init__(self):
                self.asked: list[str] = []

            async def get(self, key):
                self.asked.append(key)
                return None

        bucket = Bucket()
        migrations._applied_names = None
        worker = main.Default()
        worker.env = make_env(
            self._database(), PLAYBACK_SECRET="a-signing-key", COURSE_VIDEO=bucket
        )
        played = asyncio.run(
            worker.fetch(
                FakeRequest(
                    "/course-media/asset-1/1/master.m3u8",
                    "GET",
                    {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1", "Cookie": cookie},
                )
            )
        )

        # 404 because the fake bucket holds nothing; what matters is that the
        # token got past the gateway to be told so.
        assert played.status == 404
        assert bucket.asked == ["videos/asset-1/1/master.m3u8"]

    def test_a_worker_with_no_signing_key_refuses_rather_than_issuing_an_unsigned_token(self, call):
        assert call(self._database()).status == 503


class TestGatewayRoutes:
    """The gateway trusts a signed cookie and nothing else."""

    @pytest.fixture
    def call(self):
        import main
        from shared import migrations

        def run(request, database=None, **extra):
            migrations._applied_names = None
            worker = main.Default()
            worker.env = make_env(database or FakeDatabase(), **extra)
            return asyncio.run(worker.fetch(request))

        return run

    def _request(self, path, method="GET", **headers):
        from conftest import FakeRequest, STOREFRONT_ORIGIN

        base = {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1"}
        base.update(headers)
        return FakeRequest(path, method, base)

    def test_a_media_request_with_no_cookie_is_refused(self, call):
        response = call(self._request("/course-media/asset-1/1/master.m3u8"), PLAYBACK_SECRET="s")

        assert response.status == 403

    def test_a_path_the_pipeline_never_writes_is_not_found(self, call):
        """Refused before any signature check, so probing costs nothing to
        answer and reveals nothing about the token."""

        response = call(
            self._request("/course-media/asset-1/1/../../sources/asset-1/1/source.mp4"),
            PLAYBACK_SECRET="s",
        )

        assert response.status == 404

    def test_a_token_for_another_video_does_not_open_this_one(self, call):
        from domain import playback
        from shared.common import utc_timestamp

        # Minted now, so the only thing wrong with it is what it covers.
        token = playback.issue(
            {"assetId": "asset-9", "encodeVersion": 1}, secret="s", now=utc_timestamp()
        )
        response = call(
            self._request("/course-media/asset-1/1/master.m3u8", Cookie=f"luma_playback={token}"),
            PLAYBACK_SECRET="s",
        )

        assert response.status == 403

    def test_an_unauthorised_request_does_not_read_r2(self, call):
        """The token is checked before anything is fetched.

        Cheap to get wrong in the other order — the answer is a 403 either way —
        and getting it wrong would mean an unauthorised request still costing a
        read of a member's video.
        """

        looked_up: list[str] = []

        class RecordingBucket:
            async def get(self, key):
                looked_up.append(key)
                return None

        response = call(
            self._request("/course-media/asset-1/1/720p/segment-000001.m4s"),
            PLAYBACK_SECRET="s",
            COURSE_VIDEO=RecordingBucket(),
        )

        assert response.status == 403
        assert looked_up == []

    def test_the_object_read_is_the_one_the_key_helper_builds(self, call):
        """Pins the key. It used to be assembled by hand from a URL segment,
        which was safe only because R2 reads a key as a literal string."""

        from domain import playback, video
        from shared.common import utc_timestamp

        token = playback.issue(
            {"assetId": "asset-1", "encodeVersion": 1}, secret="s", now=utc_timestamp()
        )
        looked_up: list[str] = []

        class RecordingBucket:
            async def get(self, key):
                looked_up.append(key)
                return None

        response = call(
            self._request(
                "/course-media/asset-1/1/720p/segment-000001.m4s",
                Cookie=f"luma_playback={token}",
            ),
            PLAYBACK_SECRET="s",
            COURSE_VIDEO=RecordingBucket(),
        )

        assert response.status == 404
        assert looked_up == [f"{video.encode_prefix('asset-1', 1)}720p/segment-000001.m4s"]

    def test_the_learning_routes_need_a_session(self, call):
        assert call(self._request("/api/learning/courses")).status == 401

    def test_progress_cannot_be_recorded_against_a_course_nobody_bought(self, call):
        """A text-only lesson answers "no video", which the progress route
        treats as fine. It must not treat somebody else's course as fine."""

        from conftest import FakeRequest, STOREFRONT_ORIGIN

        class JsonRequest(FakeRequest):
            async def json(self):
                return {"positionSeconds": 10, "completed": True, "courseId": "somebody-elses"}

        database = FakeDatabase(
            {
                "FROM customer_sessions": [{
                    "id": "cust-1", "email": "a@b.c", "display_name": "",
                    "default_recipient_name": "", "default_recipient_phone": "",
                    "default_address": "", "blocked": 0,
                }],
                "SELECT * FROM course_lessons": [lesson_row(video_asset_id=None)],
                "FROM courses c JOIN course_sections": [{
                    "id": "course-1", "slug": "watercolour", "title": "水彩入門",
                    "status": "published", "created_at": 0, "updated_at": 0,
                }],
                # No entitlement at all.
                "SELECT * FROM course_entitlements": [],
            }
        )
        request = JsonRequest(
            "/api/learning/lessons/lesson-1/progress",
            "PUT",
            {
                "Origin": STOREFRONT_ORIGIN,
                "x-luma-app": "1",
                "Cookie": "luma_customer_session=" + "a" * 40,
            },
        )

        response = call(request, database)

        assert response.status == 403
        assert not any("INSERT INTO course_lesson_progress" in write[0] for write in database.writes)


class TestTheLearningPage:
    """A course as somebody who owns it reads it."""

    def _database(self, *, entitlements=None):
        return FakeDatabase(
            {
                "SELECT * FROM course_entitlements": entitlements if entitlements is not None else [entitlement_row()],
                "SELECT * FROM courses WHERE slug": [{
                    "id": "course-1", "slug": "watercolour", "title": "水彩入門", "status": "published",
                    "created_at": 0, "updated_at": 0,
                }],
                "SELECT * FROM course_sections": [
                    {"id": "s1", "course_id": "course-1", "title": "第一章", "position": 0,
                     "created_at": 0, "updated_at": 0}
                ],
                "SELECT * FROM course_lessons": [lesson_row(), lesson_row(id="lesson-2", title="調色練習")],
                "SELECT lesson_id, completed_at FROM course_lesson_progress": [
                    {"lesson_id": "lesson-1", "completed_at": 500}
                ],
            }
        )

    def test_an_owner_gets_the_lessons_and_their_content(self, learning):
        page = asyncio.run(
            learning.course_for_member(make_env(self._database()), customer_id="cust-1", slug="watercolour")
        )

        assert page["title"] == "水彩入門"
        assert page["sections"][0]["lessons"][0]["contentHtml"] == "<p>你好</p>"

    def test_progress_comes_back_with_it(self, learning):
        """Otherwise the outline is a list with no sense of where you were."""

        page = asyncio.run(
            learning.course_for_member(make_env(self._database()), customer_id="cust-1", slug="watercolour")
        )

        lessons = page["sections"][0]["lessons"]
        assert lessons[0]["completed"] is True
        assert lessons[1]["completed"] is False

    def test_somebody_without_the_course_gets_nothing(self, learning):
        """Not a redacted version — nothing. The lesson content is the product."""

        assert asyncio.run(
            learning.course_for_member(make_env(self._database(entitlements=[])), customer_id="cust-1", slug="watercolour")
        ) is None


class TestAReadingIsStillPartOfACourse:
    """A lesson with no video is not a lesson with no owner.

    The video check used to run before the entitlement check, so a text-only
    lesson answered "no video" to everybody — including somebody who had not
    bought the course. That answer was then treated as harmless, and progress
    was written against whatever course the request claimed.
    """

    def _database(self, *, entitlements):
        return FakeDatabase(
            {
                "SELECT * FROM course_entitlements": entitlements,
                "SELECT * FROM course_lessons": [lesson_row(video_asset_id=None)],
                "FROM courses c JOIN course_sections": [{
                    "id": "course-1", "slug": "watercolour", "title": "水彩入門", "status": "published",
                    "created_at": 0, "updated_at": 0,
                }],
            }
        )

    def test_somebody_without_the_course_is_told_so_not_told_there_is_no_video(self, learning):
        result = asyncio.run(
            learning.playable(make_env(self._database(entitlements=[])), customer_id="cust-1", lesson_id="lesson-1")
        )

        assert result["reason"] == "not_entitled"

    def test_an_owner_is_told_there_is_no_video(self, learning):
        result = asyncio.run(
            learning.playable(
                make_env(self._database(entitlements=[entitlement_row()])),
                customer_id="cust-1",
                lesson_id="lesson-1",
            )
        )

        assert result["reason"] == "no_video"

    def test_a_refusal_still_says_which_course_it_was_about(self, learning):
        """So progress can be recorded against the course the lesson is in
        rather than against whichever one the request named."""

        result = asyncio.run(
            learning.playable(
                make_env(self._database(entitlements=[entitlement_row()])),
                customer_id="cust-1",
                lesson_id="lesson-1",
            )
        )

        assert result["courseId"] == "course-1"


class TestServingTheBytes:
    """A segment is passed through, never read into Python.

    This is what broke the day playback first worked. `binary` copies the whole
    object twice — the ArrayBuffer R2 hands over, and the `bytes` built from it
    — and a 1080p segment is megabytes. The Worker hit its CPU limit part-way
    through and was killed:

        GET .../1080p/segment-000001.m4s - Exceeded CPU Limit

    A request killed mid-flight leaves its task half-executed, and every request
    landing on that isolate afterwards cannot enter the event loop and is
    cancelled for never answering. One segment took the whole back office down
    with it — which is how a video nobody could play became a 500 on a button
    about something else entirely.

    Streaming costs no copies: the runtime moves the bytes, Python never sees
    them.
    """

    class Stored:
        def __init__(self):
            self.body = "the-stream"
            self.read = 0

        async def arrayBuffer(self):
            self.read += 1
            return b"x" * 4_000_000

    class Bucket:
        def __init__(self, stored):
            self.stored = stored

        async def get(self, _key):
            return self.stored

    def _play(self, stored, path="asset-1/1/720p/segment-000001.m4s"):
        import asyncio

        from api import media_gateway
        from conftest import FakeDatabase, FakeRequest, STOREFRONT_ORIGIN, make_env
        from domain import playback
        from shared.common import utc_timestamp
        from shared.responses import Ctx

        token = playback.issue(
            {"assetId": "asset-1", "encodeVersion": 1}, secret="s", now=utc_timestamp()
        )
        request = FakeRequest(
            f"/course-media/{path}",
            "GET",
            {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1", "Cookie": f"luma_playback={token}"},
        )
        env = make_env(FakeDatabase(), PLAYBACK_SECRET="s", COURSE_VIDEO=self.Bucket(stored))
        ctx = Ctx(env, request, f"/course-media/{path}", {})
        return asyncio.run(media_gateway.media_response(ctx, path))

    def test_a_segment_is_streamed_rather_than_read(self):
        stored = self.Stored()

        response = self._play(stored)

        assert response.status == 200
        assert stored.read == 0, "read into Python, which is the cost that killed the isolate"
        assert response.body == "the-stream"

    def test_the_same_is_true_of_a_playlist(self):
        """Small today, and there is no reason for two ways of answering."""

        stored = self.Stored()

        self._play(stored, path="asset-1/1/720p/playlist.m3u8")

        assert stored.read == 0


class TestMediaCaching:
    """What may be kept, and what a player must be able to re-read.

    The Worker no longer copies objects into a shared cache itself: that meant
    holding a whole segment in Python, which is the cost that killed the
    isolate. What is left is the header that lets the edge and the browser keep
    the ones that can never change.
    """

    def test_a_playlist_is_not_kept_for_long(self):
        """It is what a player re-reads, and a switched encode version has to
        be picked up without waiting out a long TTL."""

        from api import media_gateway

        assert "max-age=60" in media_gateway._media_headers("master.m3u8")["Cache-Control"]

    def test_a_segment_can_be_kept_for_ever(self):
        """A re-encode is a new version and therefore a new URL, so nothing at
        this one can ever change."""

        from api import media_gateway

        assert "immutable" in media_gateway._media_headers("720p/segment-000001.m4s")["Cache-Control"]
