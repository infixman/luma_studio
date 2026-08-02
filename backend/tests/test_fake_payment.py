"""Marking an order paid with no gateway involved.

The route exists so the order lifecycle can be walked before PAYUNi is wired
up: pay, fulfil, open the course. It had no test, and it could never once have
worked.

It read the order through `orders.order_row`, which does not carry
`customer_id` — it is the customer's own view of their own order, so nobody had
needed it there. `order.get("customerId")` was therefore always `None`, never
equal to the caller's id, and every request answered "Order not found". The
storefront reads a 404 here as "this deployment has test payment switched off",
so the one message on screen was confidently about the wrong thing, and the
flag looked broken while the flag was fine.

The ownership check fifteen lines above it in the same file does it by asking
the database — which is what this now does too.
"""

import asyncio

import pytest

from conftest import FakeDatabase, FakeRequest, STOREFRONT_ORIGIN, make_env
from shared.responses import Ctx


ORDER_ID = "LS20260803yDdeWCy"
CUSTOMER = {"id": "cust-1", "email": "a@example.com"}


def an_order(**extra) -> dict:
    return {
        "id": ORDER_ID, "customer_id": "cust-1", "status": "pending_payment",
        "subtotal": 1, "shipping_fee": 0, "total": 1, "shipping_method": "none",
        "recipient_name": "我", "recipient_phone": "", "recipient_email": "a@example.com",
        "shipping_address": "", "store_name": "", "store_addr": "",
        "reserved_until": 1785292800, "paid_at": None, "created_at": 0,
        **extra,
    }


@pytest.fixture
def checkout():
    from api.front import checkout as module

    return module


def call(checkout, database, *, allow="1", customer=None):
    request = FakeRequest(
        f"/api/orders/{ORDER_ID}/fake-payment",
        "POST",
        {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1"},
    )
    env = make_env(database, ALLOW_FAKE_PAYMENT=allow)
    ctx = Ctx(env, request, f"/api/orders/{ORDER_ID}/fake-payment", {})
    return asyncio.run(checkout.fake_payment_response(ctx, customer or CUSTOMER, ORDER_ID))


class TestPayingWithoutAGateway:
    def test_the_owner_can_mark_their_own_order_paid(self, checkout):
        database = FakeDatabase(
            {"FROM orders WHERE id": [an_order()], "SELECT * FROM orders WHERE id": [an_order()]},
            changes={"UPDATE orders": 1},
        )

        response = call(checkout, database)

        assert response.status == 200
        assert any("UPDATE orders" in write[0] for write in database.writes)

    def test_it_asks_the_database_who_owns_the_order(self, checkout):
        """Not the serialised row. That view is the customer's own order and
        has never carried a customer id, so comparing against it compares
        against nothing — which is how this answered 404 for everybody."""

        database = FakeDatabase(
            {"FROM orders WHERE id": [an_order()], "SELECT * FROM orders WHERE id": [an_order()]},
            changes={"UPDATE orders": 1},
        )

        call(checkout, database)

        asked = [sql for sql in database.statements if "FROM orders" in sql and "customer_id" in sql]
        assert asked, "ownership was decided without asking who owns it"

    def test_somebody_elses_order_is_not_found(self, checkout):
        """404 rather than 403: whether an order id exists is not something a
        stranger should be able to establish by watching which error comes."""

        database = FakeDatabase({"FROM orders WHERE id": []})

        response = call(checkout, database, customer={"id": "cust-2", "email": "b@example.com"})

        assert response.status == 404
        assert not database.writes

    def test_a_deployment_that_did_not_switch_it_on_has_no_such_route(self, checkout):
        database = FakeDatabase({"FROM orders WHERE id": [an_order()]})

        response = call(checkout, database, allow="0")

        assert response.status == 404
        assert not database.statements, "the switch is checked before anything is read"

    def test_an_order_that_is_not_waiting_to_be_paid_says_so(self, checkout):
        """Paying twice is not a 404 — the order is right there, and the answer
        has to be different from "no such order" or nobody can tell them apart."""

        database = FakeDatabase(
            {"FROM orders WHERE id": [an_order(status="paid")], "SELECT * FROM orders WHERE id": [an_order(status="paid")]},
            changes={"UPDATE orders": 0},
        )

        response = call(checkout, database)

        assert response.status == 409
