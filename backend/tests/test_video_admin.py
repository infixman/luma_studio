"""The video library, minus the parts that need a bucket.

Listing, archiving and reference checks are all database work. Uploading and
transcoding need R2, a queue and a container, and are not here.
"""

import asyncio

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


@pytest.fixture
def call():
    import admin_main
    from shared import migrations

    def run(request, answers=None, changes=None):
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            FakeDatabase({**SIGNED_IN, **(answers or {})}, changes=changes),
            origins=ADMIN_ORIGIN,
            frontend=ADMIN_ORIGIN,
        )
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
