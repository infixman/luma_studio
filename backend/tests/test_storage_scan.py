"""Deciding what nothing points at.

This is the one thing in the system that reads the buckets rather than D1, and
the only one that can propose deleting a member's video. So the tests are mostly
about refusing to have an opinion: an upload in flight, an object too young to
judge, an asset whose row will exist in a minute.

Getting it wrong in the other direction costs one more sweep.
"""

import pytest


@pytest.fixture
def storage_scan():
    from domain import storage_scan as module

    return module


NOW = 1785292800
OLD = NOW - 30 * 24 * 60 * 60
ASSET = "asset-000001"


def an_object(key: str, *, uploaded_at: int = OLD) -> dict:
    return {"key": key, "size": 1024, "uploadedAt": uploaded_at}


class TestReadingAKey:
    def test_an_output_object_names_its_asset_and_version(self, storage_scan):
        found = storage_scan.classify(f"videos/{ASSET}/2/720p/segment-000001.m4s", kind="output")

        assert found == {"assetId": ASSET, "version": 2}

    def test_a_source_object_names_its_asset(self, storage_scan):
        assert storage_scan.classify(f"sources/{ASSET}/1/source.mp4", kind="source") == {
            "assetId": ASSET,
            "version": 1,
        }

    def test_the_asset_id_shape_is_the_one_the_rest_of_the_system_uses(self, storage_scan):
        """Taken from `video.ASSET_ID_PATTERN` rather than spelled again. A copy
        that drifted would call real objects rubbish — the id charset is what
        decides whether a key is one this system wrote."""

        from domain import video

        too_short = "abc"
        assert video.ASSET_ID_PATTERN.fullmatch(too_short) is None
        assert storage_scan.classify(f"videos/{too_short}/1/master.m3u8", kind="output") is None

    def test_something_this_system_did_not_write_is_not_forced_into_a_shape(self, storage_scan):
        assert storage_scan.classify("stray.txt", kind="output") is None
        assert storage_scan.classify(f"videos/{ASSET}/", kind="output") is None


class TestWhatCountsAsAnOrphan:
    def _orphan(self, storage_scan, key, *, kind="output", claimed=(), uploading=(), uploaded_at=OLD):
        return storage_scan.is_orphan(
            an_object(key, uploaded_at=uploaded_at),
            kind=kind,
            claimed=set(claimed),
            uploading=set(uploading),
            now=NOW,
        )

    def test_an_object_a_version_row_accounts_for_is_not_one(self, storage_scan):
        assert self._orphan(
            storage_scan, f"videos/{ASSET}/1/master.m3u8", claimed=[(ASSET, 1)]
        ) is False

    def test_a_version_nothing_records_is_one(self, storage_scan):
        """A replaced encode, or an upload that never registered."""

        assert self._orphan(storage_scan, f"videos/{ASSET}/7/master.m3u8", claimed=[(ASSET, 1)]) is True

    def test_an_upload_still_in_progress_is_left_alone(self, storage_scan):
        """Its objects look exactly like an abandoned upload's, because the row
        that will claim them is written when the upload finishes."""

        assert self._orphan(
            storage_scan, f"videos/{ASSET}/1/master.m3u8", claimed=[], uploading=[ASSET]
        ) is False

    def test_anything_uploaded_today_is_left_alone(self, storage_scan):
        """The scan cannot see a transfer in flight, so it refuses to have an
        opinion about one. Missing an orphan costs one more sweep; the other
        mistake costs a member's video mid-lesson."""

        assert self._orphan(
            storage_scan,
            f"videos/{ASSET}/9/master.m3u8",
            claimed=[],
            uploaded_at=NOW - 60,
        ) is False

    def test_an_object_with_no_time_at_all_is_judged(self, storage_scan):
        """R2 always reports one; a missing one is not a reason to keep an object
        forever, only a reason not to trust it as young."""

        assert self._orphan(
            storage_scan, f"videos/{ASSET}/9/master.m3u8", claimed=[], uploaded_at=0
        ) is True

    def test_something_this_system_did_not_write_is_reported(self, storage_scan):
        """Not skipped. A bucket quietly accumulating things nobody can see is
        the state this whole feature exists to end."""

        assert self._orphan(storage_scan, "notes.txt", claimed=[(ASSET, 1)]) is True

    def test_a_source_is_matched_against_the_source_claims(self, storage_scan):
        assert self._orphan(
            storage_scan, f"sources/{ASSET}/1/source.mp4", kind="source", claimed=[(ASSET, 1)]
        ) is False
        assert self._orphan(
            storage_scan, f"sources/{ASSET}/1/source.mp4", kind="source", claimed=[]
        ) is True

    def test_an_output_key_is_not_read_as_a_source_key(self, storage_scan):
        """The two prefixes are different shapes, and a bucket that answered the
        wrong pattern would report every object in it as rubbish."""

        assert self._orphan(
            storage_scan, f"videos/{ASSET}/1/master.m3u8", kind="source", claimed=[(ASSET, 1)]
        ) is True
