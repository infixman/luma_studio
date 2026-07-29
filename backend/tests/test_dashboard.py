"""The back office's front page, and the questions it is answering.

Each of these pins a decision that is invisible once it works: which orders
count as "waiting", which month a payment belongs to, and which products are
allowed to be reported as nearly sold out.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture
def dashboard():
    from domain import dashboard as module

    return module


@pytest.fixture
def shop():
    from domain import shop as module

    return module


class TestOrderCounts:
    def test_waiting_means_paid_but_not_shipped(self, dashboard):
        """The one number worth acting on: somebody has paid and has nothing yet."""

        database = FakeDatabase(
            {
                "SELECT status, COUNT(*)": [
                    {"status": "pending", "total": 2},
                    {"status": "paid", "total": 3},
                    {"status": "shipped", "total": 5},
                    {"status": "completed", "total": 9},
                ]
            }
        )
        counts = run(dashboard._order_counts(make_env(database)))
        assert counts["waiting"] == 3
        assert counts["pending"] == 2

    def test_a_status_nobody_is_in_reads_as_zero(self, dashboard):
        counts = run(dashboard._order_counts(make_env(FakeDatabase())))
        assert counts == {"pending": 0, "paid": 0, "shipped": 0, "completed": 0, "waiting": 0}


class TestRevenue:
    def test_counted_from_when_the_money_landed(self, dashboard):
        """An order placed in March and paid in April is April's money, and an
        order that was never paid is nobody's."""

        database = FakeDatabase({"COALESCE(SUM(total), 0)": [{"orders": 4, "total": 1680}]})
        run(dashboard._revenue(make_env(database), 1000))

        asked = [statement for statement in database.statements if "SUM(total)" in statement]
        assert "paid_at IS NOT NULL" in asked[0]
        assert "paid_at >= ?1" in asked[0]
        assert "created_at" not in asked[0]

    def test_no_payments_is_zero_not_null(self, dashboard):
        """COALESCE, because SUM over no rows is NULL and NULL is not a total."""

        database = FakeDatabase({"COALESCE(SUM(total), 0)": [{"orders": 0, "total": 0}]})
        assert run(dashboard._revenue(make_env(database), 1000)) == {"orders": 0, "total": 0}


class TestLowStock:
    def test_only_things_a_customer_could_actually_buy(self, dashboard, shop):
        """A product nobody can reach cannot disappoint anybody by running out.

        The status is compared against the shop's own vocabulary rather than a
        literal repeated here. This assertion used to hold a hard-coded
        'published' — the pages word — and passed for weeks against a query
        that matched no row in the database.
        """

        database = FakeDatabase()
        run(dashboard._low_stock(make_env(database)))

        query = database.statements[0]
        assert "v.enabled = 1" in query
        assert "p.status = 'active'" in query
        assert "active" in shop.PRODUCT_STATUSES
        # Worst first: the ones already at zero are turning customers away now.
        assert "ORDER BY v.stock" in query

    def test_a_low_variant_of_an_active_product_is_reported(self, dashboard):
        """The behaviour the SQL assertion above cannot see: a real row arrives."""

        database = FakeDatabase(
            {
                "FROM product_variants v": [
                    {"id": "v1", "variant_title": "M", "stock": 0, "product_title": "蘇打托特包", "slug": "soda-tote"}
                ]
            }
        )
        found = run(dashboard._low_stock(make_env(database)))
        assert [item["productTitle"] for item in found] == ["蘇打托特包"]
        assert found[0]["stock"] == 0

    def test_the_threshold_is_not_zero(self, dashboard):
        """By the time it is zero, restocking is already late."""

        assert dashboard.LOW_STOCK_AT > 0


class TestRecentPages:
    def test_the_home_page_reports_the_path_it_actually_has(self, dashboard):
        database = FakeDatabase(
            {
                "FROM pages WHERE updated_at": [
                    {"id": "p1", "title": "首頁", "path": "/welcome", "status": "published", "is_home": 1, "updated_at": 10},
                    {"id": "p2", "title": "關於", "path": "/about", "status": "draft", "is_home": 0, "updated_at": 9},
                ]
            }
        )
        pages = run(dashboard._recent_pages(make_env(database), 0))
        assert pages[0]["path"] == "/"
        assert pages[1]["path"] == "/about"
