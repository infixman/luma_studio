"""Registering a video that was transcoded somewhere else.

Without a container doing the encoding, the ladder arrives by whatever means
the admin used — usually an rclone sync of a few hundred files. A sync that
dropped one file is an ordinary occurrence, and a video missing one segment
plays fine until it reaches that segment.

So nothing is marked ready on somebody's word. The master playlist is read,
every object it refers to is checked, and only then does the asset become
playable.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p/playlist.m3u8
"""

RENDITION = """#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.000,
segment-000001.m4s
#EXTINF:6.000,
segment-000002.m4s
#EXT-X-ENDLIST
"""


@pytest.fixture
def video():
    from domain import video as module

    return module


class TestReadingAMasterPlaylist:
    def test_it_finds_every_rendition(self, video):
        assert video.renditions_in(MASTER) == ["1080p/playlist.m3u8", "720p/playlist.m3u8"]

    def test_comments_and_tags_are_not_mistaken_for_files(self, video):
        assert "#EXTM3U" not in video.renditions_in(MASTER)

    def test_an_empty_playlist_refers_to_nothing(self, video):
        assert video.renditions_in("#EXTM3U\n") == []

    def test_something_that_is_not_a_playlist_refers_to_nothing(self, video):
        """Better an empty list than a list of whatever the file happened to
        contain — the caller treats every entry as a path to fetch."""

        assert video.renditions_in("not a playlist at all") == []


class TestReadingARenditionPlaylist:
    def test_the_init_segment_is_found(self, video):
        """It is in a tag rather than on its own line, and a player cannot
        start without it."""

        assert "init.mp4" in video.segments_in(RENDITION)

    def test_every_segment_is_found(self, video):
        found = video.segments_in(RENDITION)

        assert "segment-000001.m4s" in found
        assert "segment-000002.m4s" in found

    def test_durations_are_not_mistaken_for_files(self, video):
        assert not any(entry.startswith("#") for entry in video.segments_in(RENDITION))


class TestVerifyingWhatWasUploaded:
    class Bucket:
        """Enough of an R2 binding to answer "is this object there"."""

        def __init__(self, objects: dict[str, str]):
            self.objects = objects
            self.asked: list[str] = []

        async def get(self, key: str):
            self.asked.append(key)
            body = self.objects.get(key)
            if body is None:
                return None

            class Stored:
                async def text(self_inner):
                    return body

            return Stored()

        async def head(self, key: str):
            self.asked.append(key)
            return object() if key in self.objects else None

    def _bucket(self, *, missing: str | None = None):
        objects = {
            "videos/asset-1/1/master.m3u8": MASTER,
            "videos/asset-1/1/1080p/playlist.m3u8": RENDITION,
            "videos/asset-1/1/720p/playlist.m3u8": RENDITION,
            "videos/asset-1/1/1080p/init.mp4": "",
            "videos/asset-1/1/1080p/segment-000001.m4s": "",
            "videos/asset-1/1/1080p/segment-000002.m4s": "",
            "videos/asset-1/1/720p/init.mp4": "",
            "videos/asset-1/1/720p/segment-000001.m4s": "",
            "videos/asset-1/1/720p/segment-000002.m4s": "",
        }
        if missing:
            objects.pop(missing)
        return self.Bucket(objects)

    def test_a_complete_upload_verifies(self, video):
        bucket = self._bucket()

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is True
        assert result["objectCount"] == 9

    def test_a_missing_segment_is_named(self, video):
        """A sync that dropped one file is ordinary, and the video plays fine
        until it reaches that segment."""

        bucket = self._bucket(missing="videos/asset-1/1/720p/segment-000002.m4s")

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is False
        assert "720p/segment-000002.m4s" in result["missing"]

    def test_a_missing_init_segment_is_caught(self, video):
        """Without it a player has the segments and cannot decode any of them."""

        bucket = self._bucket(missing="videos/asset-1/1/1080p/init.mp4")

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is False

    def test_no_master_playlist_at_all_is_reported_plainly(self, video):
        bucket = self.Bucket({})

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is False
        assert result["missing"] == ["master.m3u8"]

    def test_a_missing_rendition_playlist_is_named_not_followed(self, video):
        bucket = self._bucket(missing="videos/asset-1/1/720p/playlist.m3u8")

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is False
        assert "720p/playlist.m3u8" in result["missing"]

    def test_a_playlist_naming_something_outside_its_folder_is_refused(self, video):
        """A playlist is a file somebody uploaded. Following `../` out of it
        would let an upload point the verifier, and later the gateway, at
        anything in the bucket."""

        bucket = self.Bucket(
            {
                "videos/asset-1/1/master.m3u8": "#EXTM3U\n../../other/master.m3u8\n",
            }
        )

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is False
        assert any("../" in entry for entry in result["missing"])
