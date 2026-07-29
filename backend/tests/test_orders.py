"""Placing an order, and the stock arithmetic that stops it overselling.

D1 has no interactive transactions, so the guard against two people buying
the last item is a conditional UPDATE and its affected-row count. These tests
exist because that count is the only thing doing the work.
"""

import asyncio

import pytest

from conftest import STOREFRONT_ORIGIN, FakeDatabase, FakeRequest, make_env


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture
def orders():
    from domain import orders as module

    return module


CUSTOMER = {"id": "c1", "email": "buyer@example.com", "blocked": False}
METHOD = {"method": "cvs_c2c", "label": "超商", "enabled": True, "fee": 60, "freeThreshold": None}
RECIPIENT = {"name": "王小明", "phone": "0912345678", "email": "buyer@example.com", "address": ""}


def priced(*lines):
    return {
        "lines": list(lines),
        "problems": [],
        "subtotal": sum(line["lineTotal"] for line in lines),
    }


def line(variant_id="v1", quantity=1, price=300, title="蘇打托特包"):
    return {
        "variantId": variant_id,
        "productSlug": "soda-tote",
        "productTitle": title,
        "variantTitle": "M",
        "imagePath": None,
        "unitPrice": price,
        "quantity": quantity,
        "lineTotal": price * quantity,
        "stockLeft": None,
    }


class TestRecipientDetails:
    """PAYUNi rejects these at shipment time, long after the money moved."""

    def test_a_name_with_an_emoji_is_refused(self, orders):
        with pytest.raises(orders.OrderError):
            orders.validate_recipient_name("王小明🎉")

    def test_an_ordinary_name_survives_with_its_spacing_tidied(self, orders):
        assert orders.validate_recipient_name("  王 小明 ") == "王 小明"

    @pytest.mark.parametrize("value", ["0912345678", "0912-345-678", " 0912 345 678 "])
    def test_a_mobile_number_is_accepted_however_it_was_typed(self, orders, value):
        assert orders.validate_phone(value) == "0912345678"

    @pytest.mark.parametrize("value", ["0212345678", "912345678", "09123456789", "abcdefghij"])
    def test_anything_that_is_not_an_09_mobile_is_refused(self, orders, value):
        with pytest.raises(orders.OrderError):
            orders.validate_phone(value)

    def test_home_delivery_needs_an_address(self, orders):
        with pytest.raises(orders.OrderError):
            orders.validate_address("", required=True)
        assert orders.validate_address("", required=False) == ""


class TestOrderIds:
    def test_the_id_fits_what_the_gateway_accepts(self, orders):
        order_id = orders.new_order_id("20260728")
        assert orders.ORDER_ID_PATTERN.fullmatch(order_id)
        # PAYUNi's MerTradeNo limit is 25; this leaves room to spare.
        assert len(order_id) <= 25

    def test_the_id_carries_the_date_and_a_random_tail(self, orders):
        """Uniqueness rests on secure_bytes, which the test runtime stubs out.

        What can be checked here is the shape: PAYUNi refuses a MerTradeNo it
        has seen before, so the tail has to be there and has to be long
        enough for the day's volume.
        """

        order_id = orders.new_order_id("20260728")
        assert order_id.startswith("LS20260728")
        assert len(order_id.removeprefix("LS20260728")) == 7


class TestTakingStock:
    def test_one_affected_row_means_the_stock_was_there(self, orders):
        env = make_env(FakeDatabase(changes={"UPDATE product_variants SET stock = stock -": 1}))
        assert run(orders.take_stock(env, "v1", 2)) is True

    def test_no_affected_rows_means_somebody_else_got_it(self, orders):
        """The WHERE clause did the checking, so this is the only signal."""

        env = make_env(FakeDatabase(changes={"UPDATE product_variants SET stock = stock -": 0}))
        assert run(orders.take_stock(env, "v1", 2)) is False

    def test_a_driver_that_reports_nothing_is_treated_as_failure(self, orders):
        class Silent:
            def prepare(self, _sql):
                return self

            def bind(self, *_values):
                return self

            async def run(self):
                return object()

        assert run(orders.take_stock(make_env(Silent()), "v1", 1)) is False


class TestPlacingAnOrder:
    def test_an_empty_cart_is_refused(self, orders):
        with pytest.raises(orders.OrderError):
            run(
                orders.create_order(
                    make_env(), CUSTOMER, priced=priced(), method=METHOD, recipient=RECIPIENT, day="20260728"
                )
            )

    def test_the_delivery_fee_is_recomputed_rather_than_supplied(self, orders):
        database = FakeDatabase()
        env = make_env(database)
        order = run(
            orders.create_order(
                env, CUSTOMER, priced=priced(line(price=300)), method=METHOD, recipient=RECIPIENT, day="20260728"
            )
        )
        # No orders row comes back from the fake, so the insert is what to read.
        insert = next(sql for sql, _ in database.writes if sql.startswith("INSERT INTO orders"))
        bindings = next(binding for sql, binding in database.writes if sql.startswith("INSERT INTO orders"))
        assert "INSERT INTO orders" in insert
        # subtotal 300, fee 60, total 360 — positions 3, 4 and 5.
        assert bindings[2] == 300
        assert bindings[3] == 60
        assert bindings[4] == 360
        assert order is None or order["total"] == 360

    def test_a_line_that_sells_out_mid_checkout_puts_back_what_was_taken(self, orders):
        """Otherwise the earlier lines quietly leave the shelf for nobody."""

        database = FakeDatabase(changes={"UPDATE product_variants SET stock = stock -": 0})
        with pytest.raises(orders.OrderError):
            run(
                orders.create_order(
                    make_env(database),
                    CUSTOMER,
                    priced=priced(line("v1"), line("v2")),
                    method=METHOD,
                    recipient=RECIPIENT,
                    day="20260728",
                )
            )
        # Nothing was taken, so nothing needed giving back.
        assert not any(sql.startswith("UPDATE product_variants SET stock = stock +") for sql, _ in database.writes)

    def test_stock_taken_before_the_failure_is_returned(self, orders):
        class Flaky(FakeDatabase):
            """Succeeds for v1 and refuses for v2, as a real race would."""

            def _changes_for(self, sql: str) -> int:
                flat = " ".join(sql.split())
                if "stock = stock -" in flat:
                    return 0 if self.taken else 1
                return 1

            taken = False

        database = Flaky()

        original = database._changes_for

        def counting(sql: str) -> int:
            result = original(sql)
            if "stock = stock -" in " ".join(sql.split()) and result == 1:
                database.taken = True
            return result

        database._changes_for = counting

        with pytest.raises(orders.OrderError):
            run(
                orders.create_order(
                    make_env(database),
                    CUSTOMER,
                    priced=priced(line("v1"), line("v2")),
                    method=METHOD,
                    recipient=RECIPIENT,
                    day="20260728",
                )
            )
        returns = [binding for sql, binding in database.writes if sql.startswith("UPDATE product_variants SET stock = stock +")]
        assert returns == [("v1", 1)]


class TestMarkingPaid:
    def test_paying_a_pending_order_moves_it_once(self, orders):
        env = make_env(FakeDatabase(changes={"UPDATE orders SET status = 'paid'": 1}))
        assert run(orders.mark_paid(env, "LS1", "test")) is True

    def test_a_repeated_notification_changes_nothing(self, orders):
        """Every gateway eventually sends one twice; the status is in the WHERE."""

        env = make_env(FakeDatabase(changes={"UPDATE orders SET status = 'paid'": 0}))
        assert run(orders.mark_paid(env, "LS1", "test")) is False


def order_row(order_id="LS1", **overrides):
    row = {
        "id": order_id,
        "status": "paid",
        "subtotal": 300,
        "shipping_fee": 60,
        "total": 360,
        "shipping_method": "cvs_c2c",
        "recipient_name": "王小明",
        "recipient_phone": "0912345678",
        "recipient_email": "buyer@example.com",
        "shipping_address": "",
        "store_name": None,
        "store_addr": None,
        "reserved_until": None,
        "paid_at": 1000,
        "created_at": 900,
    }
    row.update(overrides)
    return row


def item_join_row(order_id="LS1", slug="soda-tote", cover="_shop/abc.jpg", title="蘇打托特包"):
    return {
        "id": "i1",
        "order_id": order_id,
        "variant_id": "v1",
        "product_title": title,
        "variant_title": "M",
        "unit_price": 300,
        "quantity": 1,
        "subtotal": 300,
        "product_slug": slug,
        "cover_key": cover,
    }


class TestTheOrderList:
    """What the customer's order list carries, and what it does without."""

    def test_each_order_arrives_with_its_own_lines(self, orders):
        env = make_env(
            FakeDatabase(
                {
                    "SELECT * FROM orders WHERE customer_id": [order_row("LS1"), order_row("LS2")],
                    "FROM order_items oi": [item_join_row("LS1"), item_join_row("LS2", title="貼紙")],
                }
            )
        )
        listed = run(orders.list_cards_for_customer(env, "c1"))

        assert [order["id"] for order in listed] == ["LS1", "LS2"]
        assert [item["productTitle"] for order in listed for item in order["items"]] == ["蘇打托特包", "貼紙"]

    def test_the_lines_cost_one_query_however_many_orders(self, orders):
        """Twenty orders must not become twenty-one round trips to D1."""

        database = FakeDatabase(
            {
                "SELECT * FROM orders WHERE customer_id": [order_row(f"LS{n}") for n in range(20)],
                "FROM order_items oi": [item_join_row(f"LS{n}") for n in range(20)],
            }
        )
        run(orders.list_cards_for_customer(make_env(database), "c1"))

        assert sum("FROM order_items" in statement for statement in database.statements) == 1

    def test_a_deleted_product_leaves_the_line_readable(self, orders):
        """The title and the price are the order's own; only the picture is the shop's."""

        env = make_env(
            FakeDatabase(
                {
                    "SELECT * FROM orders WHERE customer_id": [order_row("LS1")],
                    "FROM order_items oi": [item_join_row(slug=None, cover=None)],
                }
            )
        )
        item = run(orders.list_cards_for_customer(env, "c1"))[0]["items"][0]

        assert item["productTitle"] == "蘇打托特包"
        assert item["subtotal"] == 300
        assert item["slug"] is None
        assert item["coverPath"] is None

    def test_the_cover_becomes_a_url_the_browser_can_ask_for(self, orders):
        env = make_env(
            FakeDatabase(
                {
                    "SELECT * FROM orders WHERE customer_id": [order_row("LS1")],
                    "FROM order_items oi": [item_join_row()],
                }
            )
        )
        item = run(orders.list_cards_for_customer(env, "c1"))[0]["items"][0]

        assert item["coverPath"] == "/shop-assets/abc.jpg"

    def test_a_customer_with_no_orders_asks_for_no_lines(self, orders):
        database = FakeDatabase({"SELECT * FROM orders WHERE customer_id": []})
        assert run(orders.list_cards_for_customer(make_env(database), "c1")) == []
        assert not any("FROM order_items" in statement for statement in database.statements)

    def test_lines_belonging_to_an_order_that_is_not_listed_are_dropped(self, orders):
        """An order placed between the two queries must not crash the list."""

        env = make_env(
            FakeDatabase(
                {
                    "SELECT * FROM orders WHERE customer_id": [order_row("LS1")],
                    "FROM order_items oi": [item_join_row("LS1"), item_join_row("LS-later")],
                }
            )
        )
        listed = run(orders.list_cards_for_customer(env, "c1"))

        assert len(listed) == 1
        assert len(listed[0]["items"]) == 1

    def test_the_admin_list_is_left_as_it_was(self, orders):
        """`list_for_customer` also backs a back-office page; it gains nothing."""

        env = make_env(FakeDatabase({"SELECT * FROM orders WHERE customer_id": [order_row("LS1")]}))
        assert "items" not in run(orders.list_for_customer(env, "c1"))[0]


@pytest.fixture
def call():
    import main
    from shared import migrations

    def run_request(request, database=None, **extra):
        migrations._applied_names = None
        worker = main.Default()
        worker.env = make_env(database or FakeDatabase(), **extra)
        return asyncio.run(worker.fetch(request))

    return run_request


def storefront(path: str, method: str = "GET", **headers):
    base = {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1"}
    base.update(headers)
    return FakeRequest(path, method, base)


class TestCheckoutRoutes:
    @pytest.mark.parametrize(
        "path,method",
        [("/api/session", "GET"), ("/api/profile", "GET"), ("/api/checkout", "POST"), ("/api/orders", "GET")],
    )
    def test_everything_about_an_order_needs_a_session(self, call, path, method):
        assert call(storefront(path, method)).status == 401

    def test_the_fake_payment_route_is_absent_unless_switched_on(self, call):
        """It exists to exercise the flow before PAYUNi is wired, not to ship."""

        signed_in = FakeDatabase(
            {
                "FROM customer_sessions": [
                    {
                        "id": "c1",
                        "email": "buyer@example.com",
                        "display_name": "",
                        "default_recipient_name": "",
                        "default_recipient_phone": "",
                        "default_address": "",
                        "blocked": 0,
                    }
                ]
            }
        )
        request = storefront("/api/orders/LS1/fake-payment", "POST", Cookie="luma_customer_session=" + "a" * 40)
        assert call(request, signed_in).status == 404
