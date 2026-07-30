"""What the buckets hold, and what that costs.

The overview exists so somebody remembers to clean up, which means two things
about it: the numbers come from D1 rather than from listing the buckets — a few
hundred objects per asset, billed per object, every time the page opens — and
the money is an estimate that says so.

An out-of-date price is worse than no price, because it looks like a fact. So
the rate is configuration, and a deployment that has not set one gets no
estimate rather than a made-up one.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def video_storage():
    from domain import storage_report as module

    return module


GIGABYTE = 1024 * 1024 * 1024

TOTALS = {
    "AS objects FROM video_assets assets": [{"bytes": 200 * GIGABYTE, "objects": 42}],
    "AS objects FROM video_encode_versions": [{"bytes": 90 * GIGABYTE, "objects": 8734}],
    "WHERE sessions.updated_at >= ?1": [{"bytes": 12 * GIGABYTE}],
    "FROM video_encode_versions WHERE created_at >= ?1": [{"bytes": 8 * GIGABYTE}],
}

PRICED = {"R2_PRICE_PER_GB_MONTH_USD": "0.015", "R2_FREE_GB": "10"}


def summary_of(video_storage, answers=None, env=None, now=1785292800):
    database = FakeDatabase({**TOTALS, **(answers or {})})
    return asyncio.run(
        video_storage.summary(make_env(database, **(env if env is not None else PRICED)), now=now)
    )


class TestWhatIsStored:
    def test_an_archived_video_still_occupies_the_bucket(self, video_storage):
        """Archiving does not delete anything, and neither does abandoning an
        upload. A total that hides those bytes says the cleanup is done."""

        from domain.storage_report import SOURCE_TOTALS_SQL

        assert "status" not in SOURCE_TOTALS_SQL.split("JOIN")[0]

    def test_the_originals_come_from_the_asset_rows(self, video_storage):
        assert summary_of(video_storage)["source"] == {"bytes": 200 * GIGABYTE, "objects": 42}

    def test_the_outputs_come_from_the_encode_versions(self, video_storage):
        """Not from a listing. A few hundred objects per asset, billed per
        object, every time somebody opens the page."""

        assert summary_of(video_storage)["output"] == {"bytes": 90 * GIGABYTE, "objects": 8734}

    def test_nothing_lists_a_bucket(self, video_storage):
        """The one thing this page must not do. `verify_encode` already counted
        the bytes when it checked the objects existed."""

        bucket_calls: list[str] = []

        class Loud:
            async def list(self, **kwargs):
                bucket_calls.append("list")
                raise AssertionError("the overview must not list a bucket")

        env = make_env(FakeDatabase(TOTALS), COURSE_SOURCE=Loud(), COURSE_VIDEO=Loud(), **PRICED)
        asyncio.run(video_storage.summary(env, now=1785292800))

        assert bucket_calls == []


class TestWhatItCosts:
    def test_the_estimate_uses_the_configured_rate(self, video_storage):
        """290 GB stored, 10 free, at 0.015/GB."""

        estimate = summary_of(video_storage)["estimate"]

        assert estimate["pricePerGbMonthUsd"] == 0.015
        assert estimate["freeGb"] == 10
        assert estimate["monthlyUsd"] == pytest.approx((290 - 10) * 0.015, rel=1e-6)

    def test_it_says_that_it_excludes_operations(self, video_storage):
        """The bill has Class A and Class B operations on it too. A number that
        does not say what it leaves out gets read as the bill."""

        assert summary_of(video_storage)["estimate"]["excludesOperations"] is True

    def test_less_than_the_free_allowance_costs_nothing_rather_than_a_negative(self, video_storage):
        small = {
            "AS objects FROM video_assets assets": [{"bytes": GIGABYTE, "objects": 1}],
            "AS objects FROM video_encode_versions": [{"bytes": GIGABYTE, "objects": 12}],
        }

        assert summary_of(video_storage, answers=small)["estimate"]["monthlyUsd"] == 0

    def test_a_deployment_with_no_price_gets_no_estimate(self, video_storage):
        """R2's prices change. A stale number is worse than none, because it
        looks like a fact — and nothing here can tell that it is stale."""

        assert summary_of(video_storage, env={})["estimate"] is None

    @pytest.mark.parametrize("price", ["", "free", "-0.02"])
    def test_a_price_that_is_not_one_is_the_same_as_none(self, video_storage, price):
        assert summary_of(video_storage, env={"R2_PRICE_PER_GB_MONTH_USD": price})["estimate"] is None


class TestGrowth:
    def test_it_reports_what_arrived_this_month(self, video_storage):
        """The number that turns "it is fine" into "it was fine last year"."""

        assert summary_of(video_storage)["growth"]["bytesThisMonth"] == 20 * GIGABYTE

    def test_it_counts_the_encodes_as_well_as_the_originals(self, video_storage):
        """The encodes are usually the larger share, and an asset created last
        month whose encode landed this month grew the bucket this month."""

        without_encodes = {"FROM video_encode_versions WHERE created_at >= ?1": [{"bytes": 0}]}

        assert summary_of(video_storage, answers=without_encodes)["growth"]["bytesThisMonth"] == 12 * GIGABYTE

    def test_the_month_is_asked_for_by_its_first_second(self, video_storage):
        """Computed from the caller's `now` rather than by the database, so the
        boundary is one thing rather than SQLite's idea of a month and ours."""

        database = FakeDatabase(TOTALS)
        # 2026-07-28 12:00 UTC; the month begins 2026-07-01 00:00 UTC.
        asyncio.run(video_storage.summary(make_env(database, **PRICED), now=1785240000))

        asked = [bindings for sql, bindings in database.reads if "created_at" in sql]
        assert asked and asked[0][0] == 1782864000


class TestOrphans:
    def test_a_deployment_that_has_never_scanned_says_so(self, video_storage):
        """Not zero. Zero reads as "there are none", and the difference is the
        whole reason somebody would run a scan."""

        assert summary_of(video_storage)["orphans"] is None
