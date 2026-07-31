"""Watching what a transcode actually produced, from the back office.

The pre-launch list has an item this answers: play the output once, as quality
acceptance, without building a public entrance to it. Nothing else can tell you
that the ladder is right — the objects all exist and the manifest parses whether
or not the picture is a mess.

So the admin gets the same gateway members get, through the same token. Not a
second way into the bucket: the token still names one asset and one encode
version, still expires, and is still the only way past `media_response`. What is
new is who may be issued one.
"""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, FakeBucket, FakeDatabase, FakeObject, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}
ASSET_ID = "asset-000001"


def an_asset(**extra) -> dict:
    return {
        "id": ASSET_ID, "title": "第一課", "original_filename": "lesson-01.mp4",
        "source_key": "", "status": "ready", "byte_size": 2_000_000,
        "duration_seconds": 8, "width": 1280, "height": 720,
        "active_encode_version": 1, "master_key": f"videos/{ASSET_ID}/1/master.m3u8",
        "poster_key": f"videos/{ASSET_ID}/1/poster.webp", "error_code": None,
        "error_detail": None, "created_at": 0, "updated_at": 0,
        **extra,
    }


class Bucket(FakeBucket):
    """The shared fake, plus a record of what was asked for.

    Several of these tests are about what is *not* read — a poster the row says
    does not exist, an object behind a token that does not cover it — and a
    bucket that only answers cannot say whether it was asked.
    """

    def __init__(self, objects=None):
        super().__init__({key: FakeObject(body) for key, body in (objects or {}).items()})
        self.asked: list[str] = []

    async def get(self, key):
        self.asked.append(key)
        return await super().get(key)


@pytest.fixture
def call():
    import admin_main
    from shared import migrations

    def run(request, answers=None, bucket=None, **env):
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            FakeDatabase({**SIGNED_IN, **(answers or {})}),
            origins=ADMIN_ORIGIN,
            frontend=ADMIN_ORIGIN,
            COURSE_VIDEO=bucket if bucket is not None else Bucket(),
            **env,
        )
        return asyncio.run(worker.fetch(request))

    return run


def signed_in(path: str, method: str = "GET", cookie: str = "luma_admin_session=" + "a" * 40):
    return FakeRequest(
        path, method, {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": cookie}, host=ADMIN_HOST
    )


class TestThePoster:
    def test_it_is_served_through_the_worker_rather_than_a_signed_url(self, call):
        """A URL for a private object is a capability that outlives the page it
        was put on. The bytes come through here instead, so nothing is handed
        out that can be forwarded."""

        bucket = Bucket({f"videos/{ASSET_ID}/1/poster.webp": b"webp"})

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/poster"),
            {"SELECT * FROM video_assets": [an_asset()]},
            bucket=bucket,
        )

        assert response.status == 200
        assert bucket.asked == [f"videos/{ASSET_ID}/1/poster.webp"]
        assert "X-Amz-Signature" not in str(response.headers)

    def test_an_asset_with_no_poster_is_not_found_without_asking_the_bucket(self, call):
        """The row is the record of what the encode contains. Going to R2 anyway
        would make a stale object at that key answer for one nothing recorded."""

        bucket = Bucket({f"videos/{ASSET_ID}/1/poster.webp": b"webp"})

        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/poster"),
            {"SELECT * FROM video_assets": [an_asset(poster_key=None)]},
            bucket=bucket,
        )

        assert response.status == 404
        assert bucket.asked == []

    def test_it_needs_a_session(self, call):
        anonymous = FakeRequest(
            f"/api/video-assets/{ASSET_ID}/poster", "GET",
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST,
        )

        assert call(anonymous).status == 401

    def test_the_desktop_token_cannot_read_it(self):
        """The tool wrote the poster. Reading one back is the back office
        looking at its own library, which is not part of uploading."""

        from domain import desktop_auth

        assert desktop_auth.scope_allows("video", "GET", f"/api/video-assets/{ASSET_ID}/poster") is False


class TestPreviewingTheEncode:
    def _preview(self, call, asset=None, **env):
        return call(
            signed_in(f"/api/video-assets/{ASSET_ID}/playback-preview", "POST"),
            {"SELECT * FROM video_assets": [asset or an_asset()]},
            PLAYBACK_SECRET="a-signing-key",
            **env,
        )

    def test_it_hands_back_a_url_and_a_cookie_scoped_to_that_encode(self, call):
        response = self._preview(call)

        assert response.status == 200
        assert response.json()["playbackUrl"] == f"/course-media/{ASSET_ID}/1/master.m3u8"
        assert f"Path=/course-media/{ASSET_ID}/1/" in response.headers["set-cookie"]

    def test_the_cookie_is_not_reachable_from_script(self, call):
        """It is a capability. A token a page can read is a token a page can
        send somewhere else."""

        cookie = self._preview(call).headers["set-cookie"]

        assert "HttpOnly" in cookie and "Secure" in cookie

    def test_a_video_with_nothing_playable_is_refused(self, call):
        """No active encode version means there is nothing to watch, and a
        player pointed at a missing manifest looks like a broken video."""

        response = self._preview(call, asset=an_asset(active_encode_version=None, status="uploading"))

        assert response.status == 409

    def test_a_worker_with_no_signing_key_says_so(self, call):
        response = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/playback-preview", "POST"),
            {"SELECT * FROM video_assets": [an_asset()]},
        )

        assert response.status == 503

    def test_the_desktop_token_cannot_mint_one(self):
        from domain import desktop_auth

        assert (
            desktop_auth.scope_allows("video", "POST", f"/api/video-assets/{ASSET_ID}/playback-preview")
            is False
        )


class TestTheWholeWayThrough:
    """Minting a token and then using it, in one test.

    The two halves are checked separately above, and separately they both pass
    while naming different assets — which would be a preview that mints a
    perfectly good token for something else and then refuses it.
    """

    def test_the_cookie_the_route_hands_back_opens_that_asset(self, call):
        # Real time on both sides: a token minted now and verified against a
        # frozen past reads as issued in the future, which is refused — and the
        # refusal would look like the thing this test is checking for.
        minted = call(
            signed_in(f"/api/video-assets/{ASSET_ID}/playback-preview", "POST"),
            {"SELECT * FROM video_assets": [an_asset()]},
            PLAYBACK_SECRET="a-signing-key",
        )
        cookie = minted.headers["set-cookie"].split(";")[0]
        bucket = Bucket({f"videos/{ASSET_ID}/1/master.m3u8": b"#EXTM3U"})

        played = call(
            FakeRequest(
                f"/course-media/{ASSET_ID}/1/master.m3u8",
                "GET",
                {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": cookie},
                host=ADMIN_HOST,
            ),
            bucket=bucket,
            PLAYBACK_SECRET="a-signing-key",
        )

        assert played.status == 200
        assert bucket.asked == [f"videos/{ASSET_ID}/1/master.m3u8"]


class TestServingThePreview:
    def _media(self, call, cookie: str, bucket=None):
        return call(
            FakeRequest(
                f"/course-media/{ASSET_ID}/1/master.m3u8",
                "GET",
                {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": cookie},
                host=ADMIN_HOST,
            ),
            bucket=bucket,
            PLAYBACK_SECRET="a-signing-key",
        )

    def _token(self) -> str:
        from domain import playback

        return playback.issue(
            {"assetId": ASSET_ID, "encodeVersion": 1, "scope": "adminPreview"},
            secret="a-signing-key",
            now=1785292800,
        )

    def test_the_token_opens_the_objects_it_names(self, call, monkeypatch):
        from api import media_gateway

        monkeypatch.setattr(media_gateway, "utc_timestamp", lambda: 1785292800)
        bucket = Bucket({f"videos/{ASSET_ID}/1/master.m3u8": b"#EXTM3U"})

        response = self._media(call, f"luma_playback={self._token()}", bucket=bucket)

        assert response.status == 200
        assert bucket.asked == [f"videos/{ASSET_ID}/1/master.m3u8"]

    def test_without_a_token_it_reads_neither_r2_nor_anything_else(self, call):
        """The same rule as on the storefront: authorisation before the bucket,
        and one answer for missing, expired and forged."""

        bucket = Bucket({f"videos/{ASSET_ID}/1/master.m3u8": b"#EXTM3U"})

        response = self._media(call, "luma_admin_session=" + "a" * 40, bucket=bucket)

        assert response.status == 403
        assert bucket.asked == []

    def test_a_token_for_another_asset_does_not_open_this_one(self, call, monkeypatch):
        from api import media_gateway
        from domain import playback

        monkeypatch.setattr(media_gateway, "utc_timestamp", lambda: 1785292800)
        other = playback.issue(
            {"assetId": "asset-000002", "encodeVersion": 1, "scope": "adminPreview"},
            secret="a-signing-key",
            now=1785292800,
        )
        bucket = Bucket({f"videos/{ASSET_ID}/1/master.m3u8": b"#EXTM3U"})

        response = self._media(call, f"luma_playback={other}", bucket=bucket)

        assert response.status == 403
        assert bucket.asked == []
