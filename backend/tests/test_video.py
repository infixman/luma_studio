"""Getting a large file into private storage, and out again as HLS.

The browser uploads straight to R2 rather than through this Worker, so most of
what is here is arithmetic and state: how big a part may be, which object key
a piece of output belongs at, and which status changes are allowed.

The arithmetic is the part worth testing hardest. R2 caps a multipart upload
at 10,000 parts and refuses any part under 5 MiB except the last, so a part
size chosen carelessly fails at 99% of a two-hour upload rather than at zero.
"""

import pytest


MIB = 1024 * 1024


@pytest.fixture
def video():
    from domain import video as module

    return module


class TestPartSize:
    def test_a_small_file_uses_the_smallest_legal_part(self, video):
        assert video.part_size_for(10 * MIB) == video.MIN_PART_SIZE

    def test_a_file_near_the_ceiling_still_fits_inside_the_part_limit(self, video):
        """10,000 parts at 5 MiB is about 49 GiB, and the shop's own ceiling
        is below that — so the smallest part is always enough here. The
        assertion is that it stays true if either number is ever changed."""

        chosen = video.part_size_for(video.MAX_UPLOAD_BYTES)

        assert video.part_count_for(video.MAX_UPLOAD_BYTES, chosen) <= video.MAX_PARTS

    @pytest.mark.parametrize("size", [1, MIB, 100 * MIB, 4 * 1024 * MIB, 20 * 1024 * MIB])
    def test_every_size_lands_within_both_limits(self, video, size):
        chosen = video.part_size_for(size)

        assert chosen >= video.MIN_PART_SIZE
        assert -(-size // chosen) <= video.MAX_PARTS

    def test_a_part_size_is_a_whole_number_of_mebibytes(self, video):
        """Ragged sizes make the client's arithmetic and ours disagree at the
        last part, which is exactly where a mismatch is expensive."""

        assert video.part_size_for(3 * 1024 * MIB) % MIB == 0

    @pytest.mark.parametrize("size", [0, -1])
    def test_a_file_with_no_bytes_is_refused(self, video, size):
        with pytest.raises(ValueError):
            video.part_size_for(size)

    def test_a_file_beyond_what_the_shop_accepts_is_refused(self, video):
        with pytest.raises(ValueError):
            video.part_size_for(video.MAX_UPLOAD_BYTES + 1)


class TestPartNumbers:
    def test_the_first_part_is_one_not_zero(self, video):
        """S3 numbers parts from 1. Sending 0 fails at the last step."""

        assert video.validate_part_number(1, part_count=10) == 1

    @pytest.mark.parametrize("value", [0, -1, 11, 1.5, "2", True])
    def test_anything_outside_the_upload_is_refused(self, video, value):
        with pytest.raises(ValueError):
            video.validate_part_number(value, part_count=10)


class TestObjectKeys:
    def test_a_source_key_is_derived_rather_than_taken_from_the_filename(self, video):
        """A filename is attacker-controlled and often unusable as a path."""

        key = video.source_key("asset-1", 1)

        assert key == "sources/asset-1/1/source.mp4"

    def test_output_keys_are_versioned_so_a_re_encode_does_not_overwrite(self, video):
        assert video.master_key("asset-1", 2) == "videos/asset-1/2/master.m3u8"
        assert video.rendition_key("asset-1", 2, "720p", "playlist.m3u8") == "videos/asset-1/2/720p/playlist.m3u8"
        assert video.poster_key("asset-1", 2) == "videos/asset-1/2/poster.webp"

    @pytest.mark.parametrize("asset_id", ["../etc", "a/b", "a b", "", "a" * 100])
    def test_an_id_that_could_escape_its_prefix_is_refused(self, video, asset_id):
        with pytest.raises(ValueError):
            video.source_key(asset_id, 1)

    @pytest.mark.parametrize("name", ["../master.m3u8", "a/b.m3u8", "master.exe", "", "seg 1.m4s"])
    def test_an_output_name_outside_the_allowed_shapes_is_refused(self, video, name):
        with pytest.raises(ValueError):
            video.rendition_key("asset-1", 1, "720p", name)

    @pytest.mark.parametrize("rendition", ["1080p", "720p", "480p"])
    def test_the_rendition_names_are_the_ones_the_ladder_produces(self, video, rendition):
        assert video.rendition_key("asset-1", 1, rendition, "init.mp4").endswith(f"{rendition}/init.mp4")

    def test_an_unknown_rendition_is_refused(self, video):
        with pytest.raises(ValueError):
            video.rendition_key("asset-1", 1, "4k", "init.mp4")


class TestStatusChanges:
    @pytest.mark.parametrize(
        "before,after",
        [
            ("uploading", "uploaded"),
            ("uploading", "aborted"),
            ("uploaded", "queued"),
            ("queued", "processing"),
            ("processing", "ready"),
            ("processing", "failed"),
            ("failed", "queued"),
            ("ready", "queued"),
            ("ready", "archived"),
        ],
    )
    def test_the_moves_the_pipeline_actually_makes(self, video, before, after):
        assert video.can_change(before, after) is True

    @pytest.mark.parametrize(
        "before,after",
        [
            # Skipping the upload would mean encoding a file that is not there.
            ("uploading", "ready"),
            ("uploading", "processing"),
            # Nothing comes back from archived by accident.
            ("archived", "ready"),
            ("aborted", "uploaded"),
            # A finished encode does not un-finish.
            ("ready", "processing"),
            ("ready", "failed"),
        ],
    )
    def test_the_moves_that_would_mean_something_went_wrong(self, video, before, after):
        assert video.can_change(before, after) is False

    def test_a_status_nobody_defined_is_not_a_destination(self, video):
        assert video.can_change("ready", "publushed") is False


class TestRenditionLadder:
    def test_a_source_is_never_scaled_up(self, video):
        """Upscaling costs bandwidth and storage to deliver a blurrier file
        than the one that came in."""

        assert video.ladder_for(height=720) == ["720p", "480p"]

    def test_a_large_source_gets_the_whole_ladder(self, video):
        assert video.ladder_for(height=2160) == ["1080p", "720p", "480p"]

    def test_a_small_source_still_gets_something_playable(self, video):
        assert video.ladder_for(height=360) == ["480p"]

    def test_a_source_of_unknown_height_is_refused_rather_than_guessed(self, video):
        with pytest.raises(ValueError):
            video.ladder_for(height=0)


class TestAssetLifecycle:
    """Reading and moving an asset, with the race the pipeline actually has."""

    def _database(self, assets=None, **extra):
        from conftest import FakeDatabase

        return FakeDatabase({"SELECT * FROM video_assets": assets or [], **extra})

    def _asset(self, status="uploading", **extra):
        return {
            "id": "asset-1", "title": "第一課", "original_filename": "lesson-01.mp4",
            "source_key": "sources/asset-1/1/source.mp4", "status": status,
            "byte_size": 2_000_000, "duration_seconds": None, "width": None, "height": None,
            "active_encode_version": None, "master_key": None, "poster_key": None,
            "error_code": None, "error_detail": None, "created_at": 0, "updated_at": 0,
            **extra,
        }

    def test_a_public_row_never_carries_an_object_key(self, video):
        """These reach the back office over the network. An object key is a
        thing to go looking for; the browser has no use for one."""

        row = video.asset_row(self._asset(status="ready", master_key="videos/asset-1/1/master.m3u8"))

        assert "sourceKey" not in row
        assert "masterKey" not in row
        assert row["status"] == "ready"

    def test_a_move_the_pipeline_does_not_make_is_refused_before_any_write(self, video):
        import asyncio
        from conftest import make_env

        database = self._database([self._asset(status="uploading")])

        assert asyncio.run(video.change_status(make_env(database), "asset-1", "ready")) is False
        assert database.writes == []

    def test_the_row_has_to_still_be_where_it_was_read(self, video):
        """Two callbacks for one asset arrive at once; the WHERE clause is
        what makes the second do nothing."""

        import asyncio
        from conftest import make_env

        database = self._database([self._asset(status="queued")])

        asyncio.run(video.change_status(make_env(database), "asset-1", "processing"))

        statement, bindings = database.writes[0]
        assert "AND status = ?" in statement
        assert "queued" in bindings

    def test_failing_records_why_so_an_admin_can_act_on_it(self, video):
        import asyncio
        from conftest import make_env

        database = self._database([self._asset(status="processing")])

        asyncio.run(
            video.change_status(
                make_env(database), "asset-1", "failed", error_code="unsupported_codec", error_detail="av1"
            )
        )

        statement, bindings = database.writes[0]
        assert "error_code" in statement
        assert "unsupported_codec" in bindings

    def test_becoming_ready_clears_a_previous_failure(self, video):
        """A retry that succeeded must not leave last week's error on screen."""

        import asyncio
        from conftest import make_env

        database = self._database([self._asset(status="processing", error_code="timeout")])

        asyncio.run(video.change_status(make_env(database), "asset-1", "ready"))

        statement, _ = database.writes[0]
        assert "error_code = NULL" in statement


class TestTheEncodePrefix:
    """One place that says where an encode's objects live.

    It had five: three key builders, the verifier, and the playback gateway —
    and the gateway built its copy out of an asset id that came from the URL.
    Nothing was exploitable, but only because R2 treats a key as a literal
    string and would not resolve the `..` somebody could have put there.
    """

    def test_it_is_where_the_key_builders_put_things(self, video):
        prefix = video.encode_prefix("asset-1", 2)

        assert video.master_key("asset-1", 2).startswith(prefix)
        assert video.poster_key("asset-1", 2).startswith(prefix)
        assert video.rendition_key("asset-1", 2, "720p", "init.mp4").startswith(prefix)

    def test_it_validates_the_asset_id(self, video):
        with pytest.raises(ValueError):
            video.encode_prefix("..", 1)

    def test_it_validates_the_version(self, video):
        with pytest.raises(ValueError):
            video.encode_prefix("asset-1", 0)

    def test_the_source_prefix_is_where_the_original_goes(self, video):
        assert video.source_key("asset-1", 1).startswith(video.source_prefix("asset-1", 1))


class TestWhichObjectsExist:
    """The shapes the encoder writes, and nothing else.

    This list is consulted by two things with opposite failure modes: the
    signer decides what may be written, the gateway decides what may be read.
    Two copies of it would drift, and the day they drifted the signer would
    accept an object the gateway refuses to serve.
    """

    @pytest.mark.parametrize(
        "path",
        ["master.m3u8", "poster.webp", "720p/playlist.m3u8", "720p/init.mp4", "1080p/segment-000001.m4s"],
    )
    def test_what_the_encoder_produces_is_allowed(self, video, path):
        assert video.allowed_object(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "",
            "source.mp4",
            "720p/notes.txt",
            "999p/playlist.m3u8",
            "master.m3u8/../../x",
            "../master.m3u8",
            "/master.m3u8",
            "/etc/passwd",
            "../../sources/asset-1/1/source.mp4",
            "720p/../../other/master.m3u8",
            # Encoded and backslash forms, because a check written against `/`
            # alone reads these as ordinary names.
            "..%2Fsource.mp4",
            r"720p\..\master.m3u8",
        ],
    )
    def test_anything_else_is_refused(self, video, path):
        assert video.allowed_object(path) is False

    def test_every_rung_of_the_ladder_is_allowed(self, video):
        """The patterns are built from `RENDITIONS` rather than repeating it.

        They used to be a separate hardcoded list, so adding a rung would have
        produced output the signer accepts and the gateway then refuses to
        serve — an asset that verifies and does not play.
        """

        for rendition in video.RENDITION_NAMES:
            assert video.allowed_object(f"{rendition}/playlist.m3u8") is True
            assert video.allowed_object(f"{rendition}/init.mp4") is True
            assert video.allowed_object(f"{rendition}/segment-000001.m4s") is True


class TestWhatMayBeSigned:
    """A presigned URL is the only thing the desktop tool can do to a bucket,
    so this is where "one object, this asset, this version" is enforced.

    Refusals raise rather than return False: a caller that forgets to check a
    boolean signs whatever it was given, and there is no safe default here.
    """

    def test_an_output_object_of_this_encode_is_signable(self, video):
        key = "videos/asset-1/2/1080p/segment-000123.m4s"

        assert video.signable_key(key, asset_id="asset-1", version=2, kind="output") == key

    def test_the_master_and_poster_are_signable(self, video):
        for key in (video.master_key("asset-1", 2), video.poster_key("asset-1", 2)):
            assert video.signable_key(key, asset_id="asset-1", version=2, kind="output") == key

    def test_the_original_is_signable_as_a_source(self, video):
        key = video.source_key("asset-1", 1)

        assert video.signable_key(key, asset_id="asset-1", version=1, kind="source") == key

    def test_another_assets_object_is_refused(self, video):
        """The one refusal that matters most: the token names an asset, and a
        caller must not be able to write into somebody else's."""

        with pytest.raises(ValueError):
            video.signable_key(
                "videos/asset-2/2/master.m3u8", asset_id="asset-1", version=2, kind="output"
            )

    def test_another_version_of_this_asset_is_refused(self, video):
        """Writing into the version members are watching, while claiming to
        upload a new one."""

        with pytest.raises(ValueError):
            video.signable_key(
                "videos/asset-1/1/master.m3u8", asset_id="asset-1", version=2, kind="output"
            )

    def test_a_source_key_cannot_be_signed_as_an_output(self, video):
        """`kind` picks the bucket, so a key of the wrong shape for it would be
        a write into the other bucket's namespace."""

        with pytest.raises(ValueError):
            video.signable_key(
                video.source_key("asset-1", 1), asset_id="asset-1", version=1, kind="output"
            )

    def test_an_output_key_cannot_be_signed_as_a_source(self, video):
        with pytest.raises(ValueError):
            video.signable_key(
                video.master_key("asset-1", 1), asset_id="asset-1", version=1, kind="source"
            )

    def test_a_file_the_pipeline_never_writes_is_refused(self, video):
        with pytest.raises(ValueError):
            video.signable_key(
                "videos/asset-1/2/1080p/notes.txt", asset_id="asset-1", version=2, kind="output"
            )

    @pytest.mark.parametrize(
        "key",
        [
            "videos/asset-1/2/../../sources/asset-1/1/source.mp4",
            "videos/asset-1/2/720p/../../../other/master.m3u8",
            "/videos/asset-1/2/master.m3u8",
            "videos/asset-1/2/",
            "videos/asset-1/2",
            "",
        ],
    )
    def test_anything_reaching_outside_the_prefix_is_refused(self, video, key):
        with pytest.raises(ValueError):
            video.signable_key(key, asset_id="asset-1", version=2, kind="output")

    def test_an_unknown_kind_is_refused(self, video):
        """Not a default — a new bucket must be added here deliberately."""

        with pytest.raises(ValueError):
            video.signable_key(
                video.master_key("asset-1", 2), asset_id="asset-1", version=2, kind="anything"
            )
