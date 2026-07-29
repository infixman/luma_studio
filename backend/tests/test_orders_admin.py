"""Orders from the shop's side: listing, moving them along, and the audit."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def orders():
    from domain import orders as module

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
    from api.admin import orders as orders_admin_api
    from shared.responses import Ctx
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

    def test_admin_order_keeps_account_separate_from_recipient(self, orders):
        row = {
            **order(),
            "customer_email": "member@example.com",
            "customer_display_name": "會員本人",
        }
        result = orders.admin_row(row)
        assert result["customerEmail"] == "member@example.com"
        assert result["customerDisplayName"] == "會員本人"
        assert result["recipientEmail"] == "a@example.com"

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

    def test_search_covers_order_recipient_and_member_account(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?q=%E7%8E%8B"), database)
        query = [statement for statement in database.statements if "FROM orders WHERE" in statement][0]
        assert "id LIKE" in query and "recipient_name LIKE" in query and "recipient_email LIKE" in query
        assert "customers.email LIKE" in query

    def test_a_date_range_narrows_the_query_rather_than_the_answer(self, orders):
        """The list stops at a limit, so a range applied after it came back
        would narrow only the part that made it — which reads exactly like a
        complete answer and is not one."""

        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?createdFrom=1700000000&createdTo=1700086399"), database)
        query, bindings = [read for read in database.reads if "FROM orders WHERE" in read[0]][0]
        assert "created_at >= ?1" in query and "created_at <= ?2" in query
        assert bindings[:2] == (1700000000, 1700086399)

    def test_a_bound_that_is_not_a_number_is_ignored_rather_than_read_as_zero(self, orders):
        """"Everything since 1970" would look like the filter worked."""

        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?createdFrom=last-tuesday"), database)
        assert not any("created_at >=" in statement for statement in database.statements)

    def test_status_rules_stack_with_and(self, orders):
        """Two stacked "不是" rules is the pair anyone actually writes: show me
        what is still open."""

        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?statusNot=cancelled&statusNot=expired"), database)
        query, bindings = [read for read in database.reads if "FROM orders WHERE" in read[0]][0]
        assert query.count("status != ") == 2
        assert bindings[:2] == ("cancelled", "expired")

    def test_selected_statuses_are_one_or_group(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?status=paid&status=shipped"), database)
        query, bindings = [read for read in database.reads if "FROM orders WHERE" in read[0]][0]
        assert "status IN (?1, ?2)" in query
        assert bindings[:2] == ("paid", "shipped")

    def test_status_date_and_search_groups_stack_with_and(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(
            AdminRequest(
                "/api/orders?status=paid&status=shipped"
                "&createdFrom=1700000000&createdTo=1700086399&q=%E7%8E%8B"
            ),
            database,
        )
        query, bindings = [read for read in database.reads if "FROM orders WHERE" in read[0]][0]
        assert "status IN (?1, ?2) AND created_at >= ?3 AND created_at <= ?4 AND (" in query
        assert "id LIKE ?5" in query
        assert "OR recipient_name LIKE ?5" in query
        assert "OR recipient_email LIKE ?5" in query
        assert "customers.email LIKE ?5" in query
        assert bindings[:5] == ("paid", "shipped", 1700000000, 1700086399, "%王%")

    def test_one_is_rule_still_filters(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?status=paid"), database)
        query, bindings = [read for read in database.reads if "FROM orders WHERE" in read[0]][0]
        assert "status = ?1" in query and bindings[0] == "paid"

    def test_an_unknown_excluded_status_is_refused_too(self, orders):
        database = FakeDatabase()
        assert call(AdminRequest("/api/orders?statusNot=lost"), database).status == 400
        assert not any("FROM orders WHERE" in statement for statement in database.statements)

    def test_the_counts_come_back_with_the_list(self, orders):
        """One request, so the tabs cannot disagree with the rows under them."""

        # Declared first: FakeDatabase matches on substring, and both queries
        # read FROM orders.
        database = FakeDatabase({"SELECT status, COUNT(*)": [{"status": "paid", "total": 3}], "FROM orders": [order()]})
        assert body_of(call(AdminRequest("/api/orders"), database))["counts"] == {"paid": 3}


class TestPaging:
    """The list used to stop at 200 and say so, which is not a list — it is a
    promise that the rest exists somewhere unreachable."""

    def test_the_page_asked_for_becomes_a_limit_and_an_offset(self, orders):
        database = FakeDatabase({"FROM orders": [order()]})
        call(AdminRequest("/api/orders?page=3&perPage=20"), database)
        query, bindings = [
            read for read in database.reads if "FROM orders" in read[0] and " LIMIT " in read[0]
        ][0]
        assert "LIMIT" in query and "OFFSET" in query
        assert bindings[-2:] == (20, 40)

    def test_the_total_comes_from_a_count_not_from_the_rows(self, orders):
        """Otherwise the pager can only ever say "at least this many"."""

        database = FakeDatabase({"SELECT COUNT(*) AS total": [{"total": 137}], "FROM orders": [order()]})
        body = body_of(call(AdminRequest("/api/orders?perPage=20"), database))
        assert body["total"] == 137
        assert body["pages"] == 7
        assert body["page"] == 1 and body["perPage"] == 20

    def test_an_exact_multiple_does_not_gain_an_empty_last_page(self, orders):
        database = FakeDatabase({"SELECT COUNT(*) AS total": [{"total": 40}], "FROM orders": [order()]})
        assert body_of(call(AdminRequest("/api/orders?perPage=20"), database))["pages"] == 2

    def test_nothing_at_all_is_still_one_page(self, orders):
        """A pager that says "第 1 頁，共 0 頁" reads as broken."""

        database = FakeDatabase({"SELECT COUNT(*) AS total": [{"total": 0}]})
        assert body_of(call(AdminRequest("/api/orders"), database))["pages"] == 1

    def test_a_nonsense_page_lands_somewhere_sensible(self, orders):
        """A pager is navigation. A broken URL should not be an error page."""

        database = FakeDatabase({"FROM orders": [order()]})
        body = body_of(call(AdminRequest("/api/orders?page=-4&perPage=9999"), database))
        assert body["page"] == 1 and body["perPage"] == 100


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
