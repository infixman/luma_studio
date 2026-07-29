"""Checkout promotes successful delivery data to the member's defaults."""

import asyncio

import pytest

from conftest import FakeDatabase, FakeRequest, STOREFRONT_ORIGIN, make_env
from shared.responses import Ctx


class JsonRequest(FakeRequest):
    def __init__(self, body):
        super().__init__(
            "/api/checkout",
            "POST",
            {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1"},
        )
        self.body = body

    async def json(self):
        return self.body


def context(body):
    return Ctx(make_env(FakeDatabase()), JsonRequest(body), "/api/checkout", {})


@pytest.fixture
def checkout(monkeypatch):
    from api.front import checkout as module

    async def price_lines(_env, _lines):
        return {
            "lines": [{"variantId": "v1", "offerId": "v1", "quantity": 1, "requiresShipping": True}],
            "problems": [],
            "subtotal": 100,
            "shippingSubtotal": 100,
            "requiresShipping": True,
            "containsCourse": False,
        }

    async def get_method(_env, _method):
        return {"method": "cvs_c2c", "enabled": True}

    async def create_order(*_args, **_kwargs):
        return {"id": "LS123456", "status": "pending"}

    async def list_items(*_args):
        return []

    async def no_mail(*_args, **_kwargs):
        return None

    monkeypatch.setattr(module.cart, "parse_lines", lambda _raw: [{"variantId": "v1", "quantity": 1}])
    monkeypatch.setattr(module.cart, "price_lines", price_lines)
    monkeypatch.setattr(module.shipping, "get_method", get_method)
    monkeypatch.setattr(module.orders, "create_order", create_order)
    monkeypatch.setattr(module.orders, "list_items", list_items)
    monkeypatch.setattr(module.mail, "queue_order_event", no_mail)
    monkeypatch.setattr(module.mail, "queue_owner_alert", no_mail)
    return module


def test_successful_checkout_updates_member_defaults_without_erasing_home_address(checkout, monkeypatch):
    written = {}

    async def update_profile(_env, customer_id, **profile):
        written.update({"customerId": customer_id, **profile})

    monkeypatch.setattr(checkout.auth_customer, "update_profile", update_profile)
    customer = {
        "id": "customer-1",
        "email": "member@example.com",
        "address": "原本的宅配地址",
        "blocked": False,
        "cartBlocked": False,
    }
    response = asyncio.run(
        checkout.checkout_response(
            context(
                {
                    "lines": [{"variantId": "v1", "quantity": 1}],
                    "shippingMethod": "cvs_c2c",
                    "recipientName": "王小明",
                    "recipientPhone": "0912345678",
                    "recipientEmail": "member@example.com",
                }
            ),
            customer,
        )
    )
    assert response.status == 201
    assert written == {
        "customerId": "customer-1",
        "name": "王小明",
        "phone": "0912345678",
        "address": "原本的宅配地址",
    }


def test_cart_ban_stops_validation_before_reading_the_cart(checkout, monkeypatch):
    async def current_customer(_env, _request):
        return {"cartBlocked": True}

    monkeypatch.setattr(checkout.auth_customer, "current_customer", current_customer)
    response = asyncio.run(checkout.cart_validate_response(context({"lines": []})))
    assert response.status == 403
