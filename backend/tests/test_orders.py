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
        "shippingSubtotal": sum(line["lineTotal"] for line in lines if line.get("requiresShipping", True)),
    }


def line(variant_id="v1", quantity=1, price=300, title="蘇打托特包"):
    """A physical line, with the inventory component every offer now carries.

    The backfill gave each existing offer an item under its own id, which is
    why the component's target matches the offer here.
    """

    return {
        "variantId": variant_id,
        "offerId": variant_id,
        "productId": "p1",
        "productSlug": "soda-tote",
        "productTitle": title,
        "variantTitle": "M",
        "offerTitle": None,
        "imagePath": None,
        "unitPrice": price,
        "quantity": quantity,
        "lineTotal": price * quantity,
        "containsCourse": False,
        "requiresShipping": True,
        "components": [
            {
                "type": "inventory",
                "targetId": variant_id,
                "targetTitle": title,
                "sku": "",
                "quantity": 1,
                "requiredQuantity": quantity,
            }
        ],
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

        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 0})
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
        assert not any(sql.startswith("UPDATE inventory_items SET stock = stock +") for sql, _ in database.writes)

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
        returns = [binding[:2] for sql, binding in database.writes if sql.startswith("UPDATE inventory_items SET stock = stock +")]
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


def resolved_line(
    offer_id="off-1",
    *,
    quantity=1,
    price=3980,
    title="水彩完整套組",
    components=None,
    contains_course=False,
    requires_shipping=True,
):
    """A cart line in the shape `price_lines` now produces."""

    return {
        "variantId": offer_id,
        "offerId": offer_id,
        "productId": "prod-1",
        "productSlug": "watercolour-set",
        "productTitle": title,
        "variantTitle": "",
        "offerTitle": None,
        "imagePath": None,
        "unitPrice": price,
        "quantity": quantity,
        "lineTotal": price * quantity,
        "containsCourse": contains_course,
        "requiresShipping": requires_shipping,
        "components": components
        if components is not None
        else [
            {
                "type": "inventory",
                "targetId": "kit-1",
                "targetTitle": "水彩材料包",
                "sku": "KIT-1",
                "quantity": 1,
                "requiredQuantity": quantity,
            }
        ],
        "stockLeft": None,
    }


def course_component(course_id="course-1", title="水彩花卉入門", access_days=None):
    return {"type": "course", "targetId": course_id, "targetTitle": title, "accessDays": access_days}


class TestReservingAgainstInventory:
    """Stock comes off the InventoryItem, not off the offer."""

    def test_what_is_reserved_is_the_component_times_the_quantity(self, orders):
        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 1})

        run(
            orders.create_order(
                make_env(database),
                CUSTOMER,
                priced={
                    "lines": [
                        resolved_line(
                            quantity=3,
                            components=[{
                                "type": "inventory", "targetId": "kit-1", "targetTitle": "水彩材料包",
                                "sku": "KIT-1", "quantity": 2, "requiredQuantity": 6,
                            }],
                        )
                    ],
                    "problems": [],
                    "subtotal": 11940,
                    "shippingSubtotal": 11940,
                },
                method=METHOD,
                recipient=RECIPIENT,
                day="20260728",
            )
        )

        _, bindings = next(w for w in database.writes if "UPDATE inventory_items SET stock = stock -" in w[0])
        assert bindings[:2] == ("kit-1", 6)

    def test_a_line_that_sold_out_puts_back_what_was_already_taken(self, orders):
        """Otherwise a customer whose last line vanished silently removes the
        earlier lines from sale."""

        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 0})

        with pytest.raises(orders.OrderError):
            run(
                orders.create_order(
                    make_env(database),
                    CUSTOMER,
                    priced={
                        "lines": [resolved_line()],
                        "problems": [],
                        "subtotal": 3980,
                        "shippingSubtotal": 3980,
                    },
                    method=METHOD,
                    recipient=RECIPIENT,
                    day="20260728",
                )
            )

    def test_a_course_takes_no_stock(self, orders):
        database = FakeDatabase()

        run(
            orders.create_order(
                make_env(database),
                CUSTOMER,
                priced={
                    "lines": [
                        resolved_line(
                            components=[course_component()], contains_course=True, requires_shipping=False
                        )
                    ],
                    "problems": [],
                    "subtotal": 3980,
                    "shippingSubtotal": 0,
                },
                method=None,
                recipient=RECIPIENT,
                day="20260728",
            )
        )

        assert not any("UPDATE inventory_items SET stock = stock -" in w[0] for w in database.writes)


class TestWhatTheOrderPromised:
    def _place(self, orders, database, *, components, contains_course=False, requires_shipping=True, method=METHOD):
        return run(
            orders.create_order(
                make_env(database),
                CUSTOMER,
                priced={
                    "lines": [
                        resolved_line(
                            components=components,
                            contains_course=contains_course,
                            requires_shipping=requires_shipping,
                        )
                    ],
                    "problems": [],
                    "subtotal": 3980,
                    "shippingSubtotal": 3980 if requires_shipping else 0,
                },
                method=method,
                recipient=RECIPIENT,
                day="20260728",
            )
        )

    def test_each_component_becomes_a_fulfilment_snapshot(self, orders):
        """The offer can change what it grants tomorrow. What this order was
        for has to survive that."""

        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 1})

        self._place(
            orders,
            database,
            components=[
                course_component(access_days=30),
                {"type": "inventory", "targetId": "kit-1", "targetTitle": "水彩材料包",
                 "sku": "KIT-1", "quantity": 1, "requiredQuantity": 1},
            ],
            contains_course=True,
        )

        written = [bindings for statement, bindings in database.writes if "INSERT INTO order_fulfillments" in statement]
        assert len(written) == 2
        # Title and window are copied, not referenced.
        assert any("水彩花卉入門" in bindings and 30 in bindings for bindings in written)
        assert any("KIT-1" in bindings for bindings in written)

    def test_the_line_records_whether_it_ships_and_whether_it_grants(self, orders):
        database = FakeDatabase()

        self._place(
            orders,
            database,
            components=[course_component()],
            contains_course=True,
            requires_shipping=False,
            method=None,
        )

        _, bindings = next(w for w in database.writes if "INSERT INTO order_items" in w[0])
        assert "prod-1" in bindings

    def test_a_digital_order_is_stored_as_needing_no_delivery(self, orders):
        """Not as an empty address on a real shipping method, which reads as
        lost data on the order page."""

        database = FakeDatabase()

        self._place(
            orders,
            database,
            components=[course_component()],
            contains_course=True,
            requires_shipping=False,
            method=None,
        )

        _, bindings = next(w for w in database.writes if "INSERT INTO orders" in w[0])
        assert "none" in bindings


class JsonStorefrontRequest(FakeRequest):
    def __init__(self, path: str, body: dict, **headers):
        base = {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1"}
        base.update(headers)
        super().__init__(path, "POST", base)
        self._body = body

    async def json(self):
        return self._body


SESSION_COOKIE = {"Cookie": "luma_customer_session=" + "a" * 40}

SIGNED_IN_CUSTOMER = {
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


def digital_catalogue() -> dict:
    """One product sold as one course, and nothing else."""

    return {
        **SIGNED_IN_CUSTOMER,
        "FROM product_variants v JOIN products p": [{
            "id": "off-1", "product_id": "prod-1", "title": "", "price": 3980, "enabled": 1,
            "product_status": "active", "product_title": "水彩入門",
        }],
        "SELECT * FROM offer_components": [{
            "id": "oc-1", "offer_id": "off-1", "component_type": "course",
            "component_id": "course-1", "quantity": 1, "access_days": 30, "position": 0,
        }],
        "SELECT * FROM courses": [{"id": "course-1", "title": "水彩花卉入門", "status": "published"}],
        "SELECT * FROM products WHERE id": [{
            "id": "prod-1", "slug": "watercolour", "title": "水彩入門", "description": "",
            "status": "active", "position": 0, "created_at": 0, "updated_at": 0,
        }],
        # create_order reads the order back before returning it.
        "SELECT * FROM orders WHERE id": [{
            "id": "LS202607281234567", "customer_id": "c1", "status": "pending",
            "subtotal": 3980, "shipping_fee": 0, "total": 3980, "shipping_method": "none",
            "recipient_name": "王小明", "recipient_phone": "", "recipient_email": "buyer@example.com",
            "shipping_address": "", "store_name": None, "store_addr": None,
            "reserved_until": 900, "paid_at": None, "created_at": 0,
        }],
    }


class TestCheckingOutSomethingWithNothingToPost:
    """A course has no address. Asking for one is asking for nothing."""

    def _checkout(self, call, body: dict, answers: dict | None = None):
        return call(
            JsonStorefrontRequest("/api/checkout", body, **SESSION_COOKIE),
            FakeDatabase(answers or digital_catalogue()),
        )

    def test_a_course_can_be_bought_without_a_delivery_method(self, call):
        response = self._checkout(
            call,
            {
                "lines": [{"offerId": "off-1", "quantity": 1}],
                "recipientName": "王小明",
                "recipientEmail": "buyer@example.com",
            },
        )

        assert response.status == 201

    def test_no_phone_number_is_demanded_for_something_nobody_will_deliver(self, call):
        response = self._checkout(
            call,
            {
                "lines": [{"offerId": "off-1", "quantity": 1}],
                "recipientName": "王小明",
                "recipientEmail": "buyer@example.com",
            },
        )

        assert response.status == 201

    def test_a_name_is_still_required(self, call):
        """It goes on the receipt and the notification email."""

        response = self._checkout(
            call,
            {"lines": [{"offerId": "off-1", "quantity": 1}], "recipientEmail": "buyer@example.com"},
        )

        assert response.status == 400

    def test_a_cart_that_ships_still_needs_a_delivery_method(self, call):
        answers = digital_catalogue()
        answers["SELECT * FROM offer_components"] = [{
            "id": "oc-1", "offer_id": "off-1", "component_type": "inventory",
            "component_id": "kit-1", "quantity": 1, "access_days": None, "position": 0,
        }]
        answers["SELECT * FROM inventory_items"] = [{
            "id": "kit-1", "title": "材料包", "sku": "KIT-1", "stock": 5, "enabled": 1, "archived_at": None,
        }]

        response = self._checkout(
            call,
            {
                "lines": [{"offerId": "off-1", "quantity": 1}],
                "recipientName": "王小明",
                "recipientPhone": "0912345678",
                "recipientEmail": "buyer@example.com",
            },
            answers,
        )

        assert response.status == 400


class TestProvisioningAfterPayment:
    """Granting what was paid for, however many times the callback arrives."""

    def _database(self, fulfillments: list[dict], *, physical: bool = False) -> FakeDatabase:
        return FakeDatabase(
            {
                "SELECT * FROM order_fulfillments": fulfillments,
                "SELECT * FROM course_entitlements": [],
                "SELECT COUNT(*) AS physical FROM order_fulfillments": [{"physical": 1 if physical else 0}],
                "SELECT * FROM orders WHERE id": [{
                    "id": "LS1", "customer_id": "c1", "status": "paid", "subtotal": 3980,
                    "shipping_fee": 0, "total": 3980, "shipping_method": "none",
                    "recipient_name": "王小明", "recipient_phone": "", "recipient_email": "b@c.d",
                    "shipping_address": "", "store_name": None, "store_addr": None,
                    "reserved_until": None, "paid_at": 1, "created_at": 0,
                }],
            }
        )

    def _fulfillment(self, fulfillment_id="ff-1", access_days=None, status="pending"):
        return {
            "id": fulfillment_id, "order_id": "LS1", "order_item_id": "item-1",
            "fulfillment_type": "course", "target_id": "course-1", "target_title": "水彩花卉入門",
            "sku": None, "quantity": 1, "access_days": access_days, "status": status,
        }

    def test_a_paid_course_becomes_a_grant(self, orders):
        database = self._database([self._fulfillment(access_days=30)])

        run(orders.provision_paid_order(make_env(database), "LS1"))

        assert any("INSERT INTO course_entitlements" in statement for statement, _ in database.writes)

    def test_the_fulfilment_is_marked_done_so_reconciliation_can_find_the_rest(self, orders):
        database = self._database([self._fulfillment()])

        run(orders.provision_paid_order(make_env(database), "LS1"))

        assert any(
            "UPDATE order_fulfillments SET status = 'fulfilled'" in statement
            for statement, _ in database.writes
        )

    def test_a_fulfilment_already_done_is_left_alone(self, orders):
        """A resent callback must not grant a second time or re-audit.

        The query asks only for rows that are not fulfilled, so an order whose
        grants all landed hands back nothing to do.
        """

        database = self._database([])

        run(orders.provision_paid_order(make_env(database), "LS1"))

        assert not any("INSERT INTO course_entitlements" in statement for statement, _ in database.writes)

    def test_a_digital_order_completes_itself(self, orders):
        """There is no parcel to wait for, so 'paid' is not a state anybody
        is going to move it out of by hand."""

        database = self._database([self._fulfillment()])

        run(orders.provision_paid_order(make_env(database), "LS1"))

        assert any(
            "UPDATE orders SET status = 'completed'" in statement for statement, _ in database.writes
        )

    def test_an_order_with_something_to_post_stays_paid(self, orders):
        database = self._database([self._fulfillment()], physical=True)

        run(orders.provision_paid_order(make_env(database), "LS1"))

        assert not any(
            "UPDATE orders SET status = 'completed'" in statement for statement, _ in database.writes
        )

    def test_an_order_with_nothing_digital_grants_nothing(self, orders):
        database = self._database([])

        run(orders.provision_paid_order(make_env(database), "LS1"))

        assert not any("INSERT INTO course_entitlements" in statement for statement, _ in database.writes)


class TestWhatAnOrderShows:
    """An order says what is being sent and what is already available."""

    def _database(self, rows: list[dict]) -> FakeDatabase:
        return FakeDatabase({"SELECT * FROM order_fulfillments": rows})

    def _row(self, kind="course", status="pending", title="水彩花卉入門"):
        return {
            "id": f"ff-{kind}", "order_id": "LS1", "order_item_id": "item-1",
            "fulfillment_type": kind, "target_id": "t-1", "target_title": title,
            "sku": "KIT-1" if kind == "inventory" else None, "quantity": 1,
            "access_days": None, "status": status,
        }

    def test_digital_and_physical_are_separated(self, orders):
        """They move at different speeds. A course is ready the moment payment
        lands; a kit is not, and mixing them reads as one thing being late."""

        listed = run(
            orders.list_fulfillments(
                make_env(self._database([self._row("course"), self._row("inventory", title="材料包")]))
            , "LS1")
        )

        assert [entry["type"] for entry in listed] == ["course", "inventory"]

    def test_a_course_grant_is_reported_as_available_rather_than_shipped(self, orders):
        listed = run(orders.list_fulfillments(make_env(self._database([self._row(status="fulfilled")])), "LS1"))

        assert listed[0]["status"] == "fulfilled"
        assert listed[0]["targetTitle"] == "水彩花卉入門"

    def test_an_order_that_only_grants_has_nothing_to_post(self, orders):
        listed = run(orders.list_fulfillments(make_env(self._database([self._row("course")])), "LS1"))

        assert orders.has_physical(listed) is False

    def test_an_order_with_a_kit_does(self, orders):
        listed = run(orders.list_fulfillments(make_env(self._database([self._row("inventory")])), "LS1"))

        assert orders.has_physical(listed) is True


class TestShippingSomethingThatWasNeverPosted:
    """A digital order has no parcel. Marking it shipped claims one exists."""

    def test_an_order_with_nothing_to_post_cannot_be_marked_shipped(self, orders):
        """A paid order in every other respect, so the refusal can only be
        about there being no parcel."""

        database = FakeDatabase(
            {
                "SELECT * FROM order_fulfillments": [{
                    "id": "ff-1", "order_id": "LS1", "order_item_id": "item-1",
                    "fulfillment_type": "course", "target_id": "c-1", "target_title": "水彩",
                    "sku": None, "quantity": 1, "access_days": None, "status": "fulfilled",
                }],
                "SELECT * FROM orders WHERE id": [{
                    "id": "LS1", "customer_id": "c1", "status": "paid", "subtotal": 3980,
                    "shipping_fee": 0, "total": 3980, "shipping_method": "none",
                    "recipient_name": "王", "recipient_phone": "", "recipient_email": "a@b.c",
                    "shipping_address": "", "store_name": None, "store_addr": None,
                    "reserved_until": None, "paid_at": 1, "created_at": 0,
                }],
            },
            changes={"UPDATE orders SET status": 1},
        )

        assert run(orders.advance(make_env(database), "LS1", "shipped", "owner@example.com")) is None

    def test_an_order_with_a_kit_still_ships(self, orders):
        database = FakeDatabase(
            {
                "SELECT * FROM order_fulfillments": [{
                    "id": "ff-1", "order_id": "LS1", "order_item_id": "item-1",
                    "fulfillment_type": "inventory", "target_id": "kit-1", "target_title": "材料包",
                    "sku": "KIT-1", "quantity": 1, "access_days": None, "status": "pending",
                }],
                "SELECT * FROM orders WHERE id": [{
                    "id": "LS1", "customer_id": "c1", "status": "paid", "subtotal": 300,
                    "shipping_fee": 60, "total": 360, "shipping_method": "home",
                    "recipient_name": "王", "recipient_phone": "0912345678", "recipient_email": "a@b.c",
                    "shipping_address": "地址", "store_name": None, "store_addr": None,
                    "reserved_until": None, "paid_at": 1, "created_at": 0,
                }],
            },
            changes={"UPDATE orders SET status": 1},
        )

        assert run(orders.advance(make_env(database), "LS1", "shipped", "owner@example.com")) is not None
