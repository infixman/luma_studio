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
        """Enough of an R2 binding to answer "is this object there, and how big".

        `size` is on both what `get` and what `head` return, because the real
        binding puts it on both — and the byte total is collected during the
        walk this class stands in for.
        """

        def __init__(self, objects: dict[str, str]):
            self.objects = objects
            self.asked: list[str] = []

        def _stored(self, body: str):
            class Stored:
                size = len(body)

                async def text(self_inner):
                    return body

            return Stored()

        async def get(self, key: str):
            self.asked.append(key)
            body = self.objects.get(key)
            if body is None:
                return None
            return self._stored(body)

        async def head(self, key: str):
            self.asked.append(key)
            if key not in self.objects:
                return None
            return self._stored(self.objects[key])

    def _bucket(self, *, missing: str | None = None):
        objects = {
            "videos/asset-1/1/master.m3u8": MASTER,
            "videos/asset-1/1/1080p/playlist.m3u8": RENDITION,
            "videos/asset-1/1/720p/playlist.m3u8": RENDITION,
            # Bodies with a length, because the byte total is now part of what
            # this walk produces: empty strings would let a broken sum pass.
            "videos/asset-1/1/1080p/init.mp4": "i" * 700,
            "videos/asset-1/1/1080p/segment-000001.m4s": "s" * 500_000,
            "videos/asset-1/1/1080p/segment-000002.m4s": "s" * 480_000,
            "videos/asset-1/1/720p/init.mp4": "i" * 690,
            "videos/asset-1/1/720p/segment-000001.m4s": "s" * 250_000,
            "videos/asset-1/1/720p/segment-000002.m4s": "s" * 240_000,
            # The pipeline always writes one, and no playlist refers to it — which
            # is why it went unverified and unrecorded for a while.
            "videos/asset-1/1/poster.webp": "p" * 30_000,
        }
        if missing:
            objects.pop(missing)
        return self.Bucket(objects)

    def test_a_complete_upload_verifies(self, video):
        bucket = self._bucket()

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is True
        # Nine the manifest names, plus the poster it does not.
        assert result["objectCount"] == 10

    def test_the_poster_is_noticed(self, video):
        """Nothing in the manifest points at it, so it has to be looked for.

        It was not, and `register_verified_asset` wrote `poster_key` as NULL — so
        an upload that included a poster produced a library entry with no
        thumbnail, and nothing reported a problem.
        """
        bucket = self._bucket()

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["hasPoster"] is True

    def test_it_adds_up_what_the_encode_occupies(self, video):
        """The storage overview reads a number out of D1 rather than listing a
        few hundred keys per asset, so the number has to be collected here —
        during a walk that already asks R2 about every object."""

        bucket = self._bucket()

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["byteSize"] == sum(len(body) for body in bucket.objects.values())

    def test_what_is_not_there_is_not_counted(self, video):
        """A total that includes objects R2 said were missing is a total that
        drifts upwards every time an upload is retried."""

        complete = asyncio.run(video.verify_encode(self._bucket(), "asset-1", 1))
        without = asyncio.run(
            video.verify_encode(self._bucket(missing="videos/asset-1/1/poster.webp"), "asset-1", 1)
        )

        assert without["byteSize"] == complete["byteSize"] - 30_000

    def test_a_rendition_named_twice_is_counted_once(self, video):
        """The master playlist is written by the tool, by hand. A duplicated line
        in it inflated both the count and the byte total — and the total is now
        persisted and summed by the storage page, so an inflated one is a number
        somebody acts on."""

        bucket = self._bucket()
        bucket.objects["videos/asset-1/1/master.m3u8"] = MASTER + "720p/playlist.m3u8\n"

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is True
        assert result["objectCount"] == 10
        assert result["byteSize"] == sum(len(body) for body in bucket.objects.values())

    def test_a_segment_named_twice_is_counted_once(self, video):
        bucket = self._bucket()
        bucket.objects["videos/asset-1/1/720p/playlist.m3u8"] = RENDITION.replace(
            "#EXT-X-ENDLIST", "#EXTINF:6.000,\nsegment-000001.m4s\n#EXT-X-ENDLIST"
        )

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["objectCount"] == 10
        assert result["byteSize"] == sum(len(body) for body in bucket.objects.values())

    def test_a_repeated_name_is_not_fetched_twice(self, video):
        """The count survives a duplicate either way; the round trips do not.

        The playlists come out of the bucket, so their contents are the uploader's
        — and a master naming one rendition a few thousand times would turn one
        import into a few thousand walks of the same folder.
        """

        bucket = self._bucket()
        bucket.objects["videos/asset-1/1/master.m3u8"] = MASTER + "720p/playlist.m3u8\n"
        bucket.objects["videos/asset-1/1/1080p/playlist.m3u8"] = RENDITION.replace(
            "#EXT-X-ENDLIST", "#EXTINF:6.000,\nsegment-000001.m4s\n#EXT-X-ENDLIST"
        )

        asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert bucket.asked.count("videos/asset-1/1/720p/playlist.m3u8") == 1
        assert bucket.asked.count("videos/asset-1/1/1080p/segment-000001.m4s") == 1

    def test_an_object_r2_reports_no_size_for_still_verifies(self, video):
        """The count decides whether the video plays; the byte total is for the
        storage page. Refusing an encode because one HEAD came back without a
        size would turn a reporting gap into a failed upload."""

        class Sizeless(self.Bucket):
            def _stored(self, body: str):
                class Stored:
                    size = None

                    async def text(self_inner):
                        return body

                return Stored()

        bucket = Sizeless(self._bucket().objects)

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is True
        assert result["objectCount"] == 10
        assert result["byteSize"] == 0

    def test_a_missing_poster_is_reported_without_failing_the_import(self, video):
        """A video with no thumbnail plays. Refusing the whole encode over one
        would turn a cosmetic gap into a failed upload."""
        bucket = self._bucket(missing="videos/asset-1/1/poster.webp")

        result = asyncio.run(video.verify_encode(bucket, "asset-1", 1))

        assert result["ok"] is True
        assert result["hasPoster"] is False

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
