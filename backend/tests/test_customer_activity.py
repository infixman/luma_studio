"""Member activity is authenticated support data, not anonymous analytics."""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def activity():
    from domain import customer_activity

    return customer_activity


def run(value):
    return asyncio.run(value)


class TestRecording:
    def test_a_product_view_keeps_the_product_snapshot(self, activity):
        database = FakeDatabase()
        run(
            activity.record(
                make_env(database),
                "customer-1",
                event_type="product_view",
                path="/shop/paint",
                product_slug="paint",
                product_title="顏料",
            )
        )
        write = [entry for entry in database.writes if "INSERT INTO customer_events" in entry[0]][0]
        assert write[1][1:6] == ("customer-1", "product_view", "/shop/paint", "paint", "顏料")
        assert any("DELETE FROM customer_events" in entry[0] for entry in database.writes)

    def test_cart_add_needs_a_real_quantity(self, activity):
        with pytest.raises(ValueError):
            run(
                activity.record(
                    make_env(FakeDatabase()),
                    "customer-1",
                    event_type="cart_add",
                    product_slug="paint",
                    quantity=0,
                )
            )

    @pytest.mark.parametrize("path", ["https://elsewhere.example", "//elsewhere.example"])
    def test_page_path_cannot_become_an_external_url(self, activity, path):
        with pytest.raises(ValueError):
            run(activity.record(make_env(FakeDatabase()), "customer-1", event_type="page_view", path=path))


class TestReading:
    def test_recent_activity_is_newest_first_and_bounded(self, activity):
        database = FakeDatabase({"FROM customer_events": []})
        run(activity.recent(make_env(database), "customer-1", limit=500))
        query, bindings = database.reads[0]
        assert "ORDER BY created_at DESC" in query
        assert bindings == ("customer-1", 100)

    def test_summary_is_explicitly_thirty_days(self, activity):
        database = FakeDatabase(
            {
                "MAX(created_at)": [
                    {
                        "last_seen_at": 1700000000,
                        "page_views": 8,
                        "product_views": 3,
                        "cart_adds": 2,
                    }
                ]
            }
        )
        result = run(activity.summary(make_env(database), "customer-1"))
        assert result == {
            "periodDays": 30,
            "lastSeenAt": 1700000000,
            "pageViews": 8,
            "productViews": 3,
            "cartAdds": 2,
        }
