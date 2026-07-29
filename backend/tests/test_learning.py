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

    def test_the_learning_routes_need_a_session(self, call):
        assert call(self._request("/api/learning/courses")).status == 401


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
