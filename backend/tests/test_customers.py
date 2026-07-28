"""The member list: what the shop sees, blocking, and erasing."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def customers():
    import customers as module

    return module


def row(customer_id="cust1aaaaaaaaaaaaaaaaa", email="a@example.com", blocked=0, anonymized=None, orders=2, paid=980):
    return {
        "id": customer_id,
        "google_sub": "google-1",
        "email": email,
        "display_name": "王小明",
        "default_recipient_name": "王小明",
        "default_recipient_phone": "0912345678",
        "default_address": "台北市",
        "blocked": blocked,
        "anonymized_at": anonymized,
        "created_at": 1700000000,
        "updated_at": 1700000000,
        "order_count": orders,
        "paid_total": paid,
    }


class AdminRequest(FakeRequest):
    def __init__(self, path: str, method: str = "GET", body=None):
        super().__init__(path, method, {"Origin": ADMIN_ORIGIN}, host="admin-api.luma-studio.tw")
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def call(request, database=None):
    import customers_admin_api
    from responses import Ctx
    from urllib.parse import parse_qs, urlsplit

    parts = urlsplit(request.url)
    ctx = Ctx(make_env(database or FakeDatabase()), request, parts.path, parse_qs(parts.query))
    ctx.admin_email = "owner@example.com"
    return asyncio.run(customers_admin_api.handle(ctx))


def body_of(response):
    return json.loads(response.body)


class TestTheList:
    def test_the_counts_come_from_the_same_query_as_the_rows(self, customers):
        """One round trip. Asking per customer is one more for every row."""

        database = FakeDatabase({"FROM customers": [row()]})
        listed = asyncio.run(customers.list_all(make_env(database)))
        assert listed[0]["orderCount"] == 2 and listed[0]["paidTotal"] == 980
        assert len(database.statements) == 1

    def test_only_orders_that_were_paid_for_count_towards_the_total(self, customers):
        database = FakeDatabase({"FROM customers": [row()]})
        asyncio.run(customers.list_all(make_env(database)))
        assert "'paid', 'shipped', 'completed'" in database.statements[0]

    def test_search_covers_the_email_and_both_names(self, customers):
        database = FakeDatabase({"FROM customers": [row()]})
        asyncio.run(customers.list_all(make_env(database), search="王"))
        query = database.statements[0]
        assert "c.email LIKE ?1" in query and "display_name LIKE ?1" in query
        assert "default_recipient_name LIKE ?1" in query

    def test_a_customer_who_never_ordered_reports_zero_rather_than_nothing(self, customers):
        database = FakeDatabase({"FROM customers": [row(orders=0, paid=None)]})
        listed = asyncio.run(customers.list_all(make_env(database)))
        assert listed[0]["paidTotal"] == 0


class TestBlocking:
    def test_blocking_stops_checkout_and_nothing_else(self, customers):
        """It refuses a sale; it does not confiscate a receipt. The customer
        can still read the orders they already placed."""

        database = FakeDatabase(changes={"UPDATE customers": 1})
        assert asyncio.run(customers.set_blocked(make_env(database), "cust1aaaaaaaaaaaaaaaaa", True)) is True
        written = [write for write in database.writes if "UPDATE customers" in write[0]][0]
        assert written[1][1] == 1
        assert not any("customer_sessions" in write[0] for write in database.writes)

    def test_blocking_someone_who_is_gone_reports_it(self, customers):
        database = FakeDatabase(changes={"UPDATE customers": 0})
        assert call(AdminRequest("/api/customers/cust1aaaaaaaaaaaaaaaaa/blocked", "POST", {"blocked": True}), database).status == 404


class TestErasing:
    def test_the_row_and_the_orders_stay(self, customers):
        """A receipt from March cannot vanish because the buyer asked to be
        forgotten in June."""

        database = FakeDatabase(changes={"UPDATE customers": 1})
        asyncio.run(customers.anonymise(make_env(database), "cust1aaaaaaaaaaaaaaaaa"))
        assert not any("DELETE FROM customers" in write[0] for write in database.writes)
        assert not any("orders" in write[0] for write in database.writes)

    def test_the_google_account_cannot_walk_back_into_the_same_row(self, customers):
        """google_sub is overwritten, so signing in again makes a new customer."""

        database = FakeDatabase(changes={"UPDATE customers": 1})
        asyncio.run(customers.anonymise(make_env(database), "cust1aaaaaaaaaaaaaaaaa"))
        written = [write for write in database.writes if "UPDATE customers" in write[0]][0]
        assert written[1][3] == "erased:cust1aaaaaaaaaaaaaaaaa"

    def test_sessions_go_with_the_profile(self, customers):
        """A live session would keep serving a profile the row no longer holds."""

        database = FakeDatabase(changes={"UPDATE customers": 1})
        asyncio.run(customers.anonymise(make_env(database), "cust1aaaaaaaaaaaaaaaaa"))
        assert any("DELETE FROM customer_sessions" in write[0] for write in database.writes)

    def test_what_is_left_is_readable_rather_than_blank(self, customers):
        """A blank name on an order looks like a bug, and someone goes looking
        for the data that "went missing"."""

        database = FakeDatabase(changes={"UPDATE customers": 1})
        asyncio.run(customers.anonymise(make_env(database), "cust1aaaaaaaaaaaaaaaaa"))
        written = [write for write in database.writes if "UPDATE customers" in write[0]][0]
        assert written[1][2] == customers.ERASED

    def test_erasing_twice_is_refused_rather_than_repeated(self, customers):
        """The WHERE clause carries anonymized_at IS NULL, so the second
        attempt changes nothing and says so."""

        database = FakeDatabase(changes={"UPDATE customers": 0})
        response = call(AdminRequest("/api/customers/cust1aaaaaaaaaaaaaaaaa/anonymise", "POST", {}), database)
        assert response.status == 409
        assert not any("customer_sessions" in write[0] for write in database.writes)


class TestTheDoor:
    def test_an_id_that_could_not_be_ours_is_refused_before_any_query(self, customers):
        database = FakeDatabase()
        assert call(AdminRequest("/api/customers/..%2Fetc"), database).status == 400
        assert database.statements == []

    def test_a_customer_comes_back_with_their_orders(self, customers):
        database = FakeDatabase(
            {
                "FROM customers": [row()],
                "FROM orders": [
                    {
                        "id": "LS1",
                        "customer_id": "cust1aaaaaaaaaaaaaaaaa",
                        "status": "paid",
                        "subtotal": 300,
                        "shipping_fee": 60,
                        "total": 360,
                        "shipping_method": "711",
                        "recipient_name": "王小明",
                        "recipient_phone": "0912345678",
                        "recipient_email": "a@example.com",
                        "shipping_address": "",
                        "store_name": None,
                        "store_addr": None,
                        "reserved_until": None,
                        "paid_at": 1700000100,
                        "created_at": 1700000000,
                    }
                ],
            }
        )
        payload = body_of(call(AdminRequest("/api/customers/cust1aaaaaaaaaaaaaaaaa"), database))
        assert payload["customer"]["orderCount"] == 2
        assert payload["orders"][0]["id"] == "LS1"

    def test_an_unknown_action_is_a_404(self, customers):
        assert call(AdminRequest("/api/customers/cust1aaaaaaaaaaaaaaaaa/refund", "POST", {})).status == 404
