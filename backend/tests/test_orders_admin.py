"""Orders from the shop's side: listing, moving them along, and the audit."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def orders():
    import orders as module

    return module


def order(order_id="LS20260728abcdefg", status="pending", note=""):
    return {
        "id": order_id,
        "customer_id": "cust1",
        "status": status,
        "subtotal": 600,
        "shipping_fee": 60,
        "total": 660,
        "shipping_method": "711",
        "recipient_name": "王小明",
        "recipient_phone": "0912345678",
        "recipient_email": "a@example.com",
        "shipping_address": "",
        "store_name": "門市",
        "store_addr": "地址",
        "reserved_until": None,
        "paid_at": None,
        "admin_note": note,
        "created_at": 1700000000,
    }


class AdminRequest(FakeRequest):
    def __init__(self, path: str, method: str = "GET", body=None):
        super().__init__(path, method, {"Origin": ADMIN_ORIGIN}, host="admin-api.luma-studio.tw")
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def call(request, database=None, *, email="owner@example.com"):
    import orders_admin_api
    from responses import Ctx
    from urllib.parse import parse_qs, urlsplit

    parts = urlsplit(request.url)
    ctx = Ctx(make_env(database or FakeDatabase()), request, parts.path, parse_qs(parts.query))
    ctx.admin_email = email
    return asyncio.run(orders_admin_api.handle(ctx))


def body_of(response):
    return json.loads(response.body)


class TestWhatTheShopSees:
    def test_the_private_note_never_rides_along_on_a_customer_order(self, orders):
        """`order_row` is what a customer is handed. A note added to it is a
        note published on someone's order page."""

        assert "adminNote" not in orders.order_row(order(note="打過電話"))
        assert orders.admin_row(order(note="打過電話"))["adminNote"] == "打過電話"

    def test_listing_filters_by_status(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?status=paid"), database)
        query = [statement for statement in database.statements if "FROM orders WHERE" in statement][0]
        assert "status = ?1" in query

    def test_an_unknown_status_is_refused_rather_than_ignored(self, orders):
        """Silently listing everything would look like "there are no paid
        orders" to whoever typed it."""

        database = FakeDatabase()
        assert call(AdminRequest("/api/orders?status=lost"), database).status == 400
        assert not any("FROM orders WHERE" in statement for statement in database.statements)

    def test_search_covers_the_three_things_someone_writes_in_with(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?q=%E7%8E%8B"), database)
        query = [statement for statement in database.statements if "FROM orders WHERE" in statement][0]
        assert "id LIKE" in query and "recipient_name LIKE" in query and "recipient_email LIKE" in query

    def test_the_counts_come_back_with_the_list(self, orders):
        """One request, so the tabs cannot disagree with the rows under them."""

        # Declared first: FakeDatabase matches on substring, and both queries
        # read FROM orders.
        database = FakeDatabase({"SELECT status, COUNT(*)": [{"status": "paid", "total": 3}], "FROM orders": [order()]})
        assert body_of(call(AdminRequest("/api/orders"), database))["counts"] == {"paid": 3}


class TestSayingWhatWasLeftOut:
    """A list that stops at its limit and says nothing reads as "the old
    orders are gone"."""

    def test_a_full_page_is_reported_as_cut_short(self, orders):
        # One more row than the page holds, which is exactly how the query
        # finds out there is more.
        database = FakeDatabase({"FROM orders": [order(f"LS2026072{index}abcdefg") for index in range(9)]})
        rows, truncated = asyncio.run(orders.list_all(make_env(database), limit=8))
        assert len(rows) == 8 and truncated is True

    def test_a_short_page_is_not(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        rows, truncated = asyncio.run(orders.list_all(make_env(database), limit=8))
        assert len(rows) == 1 and truncated is False

    def test_the_flag_reaches_the_response(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        assert body_of(call(AdminRequest("/api/orders"), database))["truncated"] is False


class TestMovingAnOrderAlong:
    def test_paid_becomes_shipped(self, orders):
        database = FakeDatabase({"FROM orders": [order(status="paid")]}, {"UPDATE orders": 1})
        assert asyncio.run(orders.advance(make_env(database), "LS20260728abcdefg", "shipped", "me")) == "paid"
        update = [write for write in database.writes if "UPDATE orders" in write[0]][0]
        assert update[1][1] == "shipped"

    def test_the_endpoint_reports_a_move_it_could_not_make(self, orders):
        """409 rather than 200: the button did nothing, and saying so is the
        difference between "already shipped" and "did that work?"."""

        database = FakeDatabase({"FROM orders": [order(status="pending")]}, {"UPDATE orders": 1})
        response = call(AdminRequest("/api/orders/LS20260728abcdefg/shipped", "POST", {"detail": ""}), database)
        assert response.status == 409

    def test_pending_cannot_skip_straight_to_shipped(self, orders):
        database = FakeDatabase({"FROM orders": [order(status="pending")]}, {"UPDATE orders": 1})
        assert asyncio.run(orders.advance(make_env(database), "LS20260728abcdefg", "shipped", "me")) is None
        assert not any("UPDATE orders" in write[0] for write in database.writes)

    def test_nothing_moves_backwards(self, orders):
        database = FakeDatabase({"FROM orders": [order(status="completed")]}, {"UPDATE orders": 1})
        assert asyncio.run(orders.advance(make_env(database), "LS20260728abcdefg", "shipped", "me")) is None

    def test_a_status_that_is_not_a_forward_move_is_refused(self, orders):
        """`cancel` and `paid` have their own rules; this door only steps forward."""

        database = FakeDatabase({"FROM orders": [order(status="paid")]}, {"UPDATE orders": 1})
        assert asyncio.run(orders.advance(make_env(database), "LS20260728abcdefg", "cancelled", "me")) is None

    def test_the_move_names_who_made_it(self, orders):
        """"Who marked this paid" needs a name in it the day it is disputed."""

        database = FakeDatabase({"FROM orders": [order(status="paid")]}, {"UPDATE orders": 1})
        asyncio.run(orders.advance(make_env(database), "LS20260728abcdefg", "shipped", "owner@example.com"))
        entry = [write for write in database.writes if "INSERT INTO order_audit_log" in write[0]][0]
        assert entry[1][1] == "owner@example.com"
        assert entry[1][3:5] == ("paid", "shipped")

    def test_a_second_click_changes_nothing(self, orders):
        """The status it was read at is in the WHERE clause, so a race produces
        one move and one refusal rather than two audit entries."""

        database = FakeDatabase({"FROM orders": [order(status="paid")]}, {"UPDATE orders": 0})
        assert asyncio.run(orders.advance(make_env(database), "LS20260728abcdefg", "shipped", "me")) is None
        assert not any("INSERT INTO order_audit_log" in write[0] for write in database.writes)


class TestNotes:
    def test_a_note_is_audited(self, orders):
        """A note that quietly changed is a note nobody can rely on."""

        database = FakeDatabase(changes={"UPDATE orders": 1})
        assert asyncio.run(orders.set_note(make_env(database), "LS20260728abcdefg", "已聯絡", "me")) is True
        assert any("INSERT INTO order_audit_log" in write[0] for write in database.writes)

    def test_a_note_on_an_order_that_is_gone_is_a_404(self, orders):
        database = FakeDatabase(changes={"UPDATE orders": 0})
        response = call(AdminRequest("/api/orders/LS20260728abcdefg/note", "POST", {"note": "x"}), database)
        assert response.status == 404


class TestTheDoor:
    def test_an_id_that_could_not_be_ours_is_refused_before_any_query(self, orders):
        database = FakeDatabase()
        assert call(AdminRequest("/api/orders/..%2F..%2Fetc"), database).status == 400
        assert database.statements == []

    def test_an_unknown_action_is_a_404(self, orders):
        assert call(AdminRequest("/api/orders/LS20260728abcdefg/refund", "POST", {})).status == 404

    def test_reading_an_order_that_is_gone_is_a_404(self, orders):
        assert call(AdminRequest("/api/orders/LS20260728abcdefg"), FakeDatabase()).status == 404

    def test_an_order_comes_back_with_its_items_payments_and_audit(self, orders):
        database = FakeDatabase(
            {
                "FROM orders": [order()],
                "FROM order_items": [
                    {
                        "product_title": "材料包",
                        "variant_title": "標準",
                        "unit_price": 300,
                        "quantity": 2,
                        "subtotal": 600,
                    }
                ],
                "FROM payment_attempts": [
                    {"mer_trade_no": "LS1", "order_id": "x", "amount": 660, "status": "failed", "created_at": 1}
                ],
                "FROM order_audit_log": [
                    {
                        "actor": "system",
                        "action": "created",
                        "from_status": None,
                        "to_status": "pending",
                        "detail": "",
                        "created_at": 1,
                    }
                ],
            }
        )
        payload = body_of(call(AdminRequest("/api/orders/LS20260728abcdefg"), database))
        assert payload["order"]["adminNote"] == ""
        assert payload["items"][0]["quantity"] == 2
        assert payload["attempts"][0]["status"] == "failed"
        assert payload["audit"][0]["toStatus"] == "pending"
