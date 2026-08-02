"""Asking R2 for a page, in the one way it accepts.

Three call sites passed `cursor=None` on the first page. That reaches the
runtime as `null`, and R2 refuses it:

    TypeError: Incorrect type for the 'cursor' field on 'ListOptions':
    the provided value is not of type 'string'.

Every one of them was a 500 the first time anybody pressed the button — the
desktop tool's "did the files arrive", the orphan scan, and the release list —
and all three had passing tests, because the fake bucket accepted whatever it
was handed. A double that is kinder than production tests nothing.

So `conftest.FakeBucket` refuses it now, and these are the tests that would have
caught it: each caller asked for its first page, against a bucket that behaves
like the real one.
"""

import asyncio

import pytest

from conftest import FakeBucket, FakeDatabase, FakeListed, FakeListing, make_env


class Recording(FakeBucket):
    """Remembers the options each page was asked for."""

    def __init__(self, objects=None, pages=None):
        super().__init__(objects)
        self.asked: list[dict] = []
        self.pages = pages

    async def list(self, **options):
        self.asked.append(options)
        if self.pages is None:
            return await super().list(**options)
        from conftest import reject_null_cursor

        reject_null_cursor(options)
        return self.pages[min(len(self.asked) - 1, len(self.pages) - 1)]


@pytest.fixture
def video_storage():
    from domain import video_storage as module

    return module


class TestTheHelper:
    def test_the_first_page_carries_no_cursor_at_all(self, video_storage):
        bucket = Recording()

        asyncio.run(video_storage.list_page(bucket, prefix="videos/", limit=10))

        assert "cursor" not in bucket.asked[0]

    def test_a_later_page_carries_the_one_it_was_given(self, video_storage):
        bucket = Recording()

        asyncio.run(video_storage.list_page(bucket, prefix="videos/", limit=10, cursor="abc"))

        assert bucket.asked[0]["cursor"] == "abc"

    def test_an_empty_cursor_is_no_cursor(self, video_storage):
        """`""` is what a query string hands over when the parameter is present
        and blank, and R2 refuses that as readily as null."""

        bucket = Recording()

        asyncio.run(video_storage.list_page(bucket, prefix="videos/", limit=10, cursor=""))

        assert "cursor" not in bucket.asked[0]


class TestTheCallersThatWereBroken:
    def test_the_desktop_tool_can_ask_what_arrived(self, video_storage):
        """`GET /api/video-storage`, which is the tool's last question after an
        upload: did the objects actually land."""

        bucket = Recording({"videos/asset-1/1/master.m3u8": None})
        env = make_env(FakeDatabase(), COURSE_VIDEO=bucket)

        answer = asyncio.run(video_storage.list_objects(env, kind="output", prefix="videos/asset-1/"))

        assert [entry["key"] for entry in answer["objects"]] == ["videos/asset-1/1/master.m3u8"]

    def test_the_release_list_can_read_the_bucket(self):
        from domain import desktop_release

        bucket = Recording(
            pages=[FakeListing([FakeListed("releases/luma-video-uploader-0.1.0-setup.exe")])]
        )
        env = make_env(FakeDatabase(), DESKTOP_TOOLS=bucket)

        found = asyncio.run(desktop_release.refresh_releases(env, now=1785292800))

        assert [entry["version"] for entry in found["versions"]] == ["0.1.0"]
