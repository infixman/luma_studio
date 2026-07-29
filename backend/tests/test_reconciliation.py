"""Finding what the happy path dropped.

Every one of these exists because a step that should have happened might not
have. A payment lands and the grant fails; an order expires and nothing puts
the stock back; a container dies holding a job. None of those are rare enough
to leave to chance, and all of them are invisible unless something goes
looking.

The queries here are deliberately narrow. A sweep that finds everything is a
sweep nobody dares run.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def reconciliation():
    from domain import reconciliation as module

    return module


class TestPaidButNotGranted:
    def test_it_finds_orders_that_took_money_and_gave_nothing(self, reconciliation):
        database = FakeDatabase(
            {"SELECT DISTINCT o.id": [{"id": "LS1"}, {"id": "LS2"}]}
        )

        found = asyncio.run(reconciliation.orders_missing_grants(make_env(database)))

        assert found == ["LS1", "LS2"]

    def test_it_only_looks_at_paid_orders(self, reconciliation):
        """An unpaid order has nothing outstanding — it has not bought anything."""

        database = FakeDatabase()

        asyncio.run(reconciliation.orders_missing_grants(make_env(database)))

        query, _ = database.reads[0]
        assert "status = 'paid'" in query
        assert "fulfillment_type = 'course'" in query
        assert "status != 'fulfilled'" in query


class TestStockNobodyReleased:
    def test_it_finds_expired_orders_still_holding_stock(self, reconciliation):
        database = FakeDatabase({"SELECT id FROM orders": [{"id": "LS9"}]})

        found = asyncio.run(reconciliation.orders_holding_stock_past_expiry(make_env(database), now=2000))

        assert found == ["LS9"]

    def test_it_asks_only_about_orders_whose_hold_has_run_out(self, reconciliation):
        database = FakeDatabase()

        asyncio.run(reconciliation.orders_holding_stock_past_expiry(make_env(database), now=2000))

        query, bindings = database.reads[0]
        assert "status = 'pending'" in query
        assert "reserved_until <" in query
        assert 2000 in bindings


class TestStuckEncodes:
    def test_it_finds_jobs_that_stopped_reporting(self, reconciliation):
        """A container that died holding a job leaves it processing forever."""

        database = FakeDatabase({"SELECT id, asset_id FROM video_transcode_jobs": [{"id": "j1", "asset_id": "a1"}]})

        found = asyncio.run(reconciliation.stuck_transcodes(make_env(database), now=100_000))

        assert found == [{"jobId": "j1", "assetId": "a1"}]

    def test_a_job_that_started_recently_is_left_alone(self, reconciliation):
        database = FakeDatabase()

        asyncio.run(reconciliation.stuck_transcodes(make_env(database), now=100_000))

        query, bindings = database.reads[0]
        assert "started_at <" in query
        assert 100_000 - reconciliation.TRANSCODE_LEASE_SECONDS in bindings


class TestEntitlementsThatDisagreeWithTheirSources:
    def test_it_finds_access_whose_last_reason_was_revoked(self, reconciliation):
        """A refund revoked the source but the grant survived. Somebody is
        watching a course they were refunded for."""

        database = FakeDatabase({"SELECT e.id": [{"id": "ent-1"}]})

        assert asyncio.run(reconciliation.entitlements_without_live_sources(make_env(database))) == ["ent-1"]

    def test_it_ignores_grants_that_are_already_revoked(self, reconciliation):
        database = FakeDatabase()

        asyncio.run(reconciliation.entitlements_without_live_sources(make_env(database)))

        query, _ = database.reads[0]
        assert "e.revoked_at IS NULL" in query


class TestOrphanPurchaseLocks:
    def test_it_finds_locks_whose_order_never_happened(self, reconciliation):
        """A lock left behind stops a member buying something they do not own."""

        database = FakeDatabase({"SELECT l.customer_id": [{"customer_id": "c1", "offer_id": "off-1"}]})

        found = asyncio.run(reconciliation.orphan_purchase_locks(make_env(database)))

        assert found == [{"customerId": "c1", "offerId": "off-1"}]


class TestTheAdminView:
    @pytest.fixture
    def call(self):
        import admin_main
        from shared import migrations
        from conftest import ADMIN_ORIGIN, FakeRequest

        def run(request=None, **extra):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
                **extra,
            )
            return asyncio.run(worker.fetch(request))

        return run

    def _request(self, **headers):
        from conftest import ADMIN_ORIGIN, FakeRequest

        base = {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}
        base.update(headers)
        return FakeRequest("/api/health/reconciliation", "GET", base, host="admin-api.luma-studio.tw")

    def test_a_clean_shop_reports_nothing_outstanding(self, call):
        response = call(self._request(Cookie="luma_admin_session=" + "a" * 40))

        assert response.status == 200
        body = response.json()
        assert body["paidWithoutGrants"] == []
        assert body["accessWithoutSources"] == []

    def test_it_says_which_switches_are_live(self, call):
        """Which of these is on is the first question when something is not
        for sale and nobody can say why."""

        response = call(self._request(Cookie="luma_admin_session=" + "a" * 40), COURSE_CHECKOUT_ENABLED="1")

        assert response.json()["flags"]["COURSE_CHECKOUT_ENABLED"] is True

    def test_it_is_not_readable_without_a_session(self, call):
        assert call(self._request()).status == 401
