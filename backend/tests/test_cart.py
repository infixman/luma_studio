"""What the cart accepts from a browser, and what it recomputes.

The cart arrives from localStorage, so every number in it is a request rather
than a fact. These tests are mostly about the ones that get refused.
"""

import asyncio

import pytest

from conftest import FakeDatabase, FakeRequest, STOREFRONT_ORIGIN, make_env


@pytest.fixture
def cart():
    import cart as module

    return module


@pytest.fixture
def shipping():
    import shipping as module

    return module


def run(coroutine):
    return asyncio.run(coroutine)


class TestReadingTheBrowsersCart:
    def test_a_normal_cart_survives_intact(self, cart):
        lines = cart.parse_lines([{"variantId": "v1", "quantity": 2}])
        assert lines == [{"variantId": "v1", "quantity": 2}]

    def test_repeated_variants_are_merged_rather_than_refused(self, cart):
        """Two lines for one variant is a client-side merge that did not happen."""

        lines = cart.parse_lines([{"variantId": "v1", "quantity": 2}, {"variantId": "v1", "quantity": 3}])
        assert lines == [{"variantId": "v1", "quantity": 5}]

    def test_a_merge_cannot_exceed_the_per_line_cap(self, cart):
        lines = cart.parse_lines([{"variantId": "v1", "quantity": 20}, {"variantId": "v1", "quantity": 20}])
        assert lines[0]["quantity"] == cart.MAX_QUANTITY

    @pytest.mark.parametrize(
        "raw",
        [
            "not a list",
            [{"variantId": "v1"}],
            [{"variantId": "v1", "quantity": 0}],
            [{"variantId": "v1", "quantity": -3}],
            [{"variantId": "v1", "quantity": 21}],
            [{"variantId": "v1", "quantity": 1.5}],
            [{"variantId": "v1", "quantity": True}],
            [{"variantId": "", "quantity": 1}],
            ["v1"],
        ],
    )
    def test_shapes_no_honest_client_sends_are_refused(self, cart, raw):
        with pytest.raises(cart.CartError):
            cart.parse_lines(raw)

    def test_a_cart_with_too_many_distinct_items_is_refused(self, cart):
        raw = [{"variantId": f"v{index}", "quantity": 1} for index in range(cart.MAX_LINES + 1)]
        with pytest.raises(cart.CartError):
            cart.parse_lines(raw)


def stocked(*, status="active", enabled=1, stock=10, price=300):
    """A database that answers with one product and one variant."""

    return FakeDatabase(
        {
            "FROM product_variants WHERE id": [
                {
                    "id": "v1",
                    "product_id": "p1",
                    "title": "M",
                    "sku": "",
                    "price": price,
                    "stock": stock,
                    "position": 0,
                    "enabled": enabled,
                }
            ],
            "FROM products WHERE id": [
                {
                    "id": "p1",
                    "slug": "soda-tote",
                    "title": "蘇打托特包",
                    "description": "",
                    "status": status,
                    "position": 0,
                    "created_at": 1,
                    "updated_at": 1,
                }
            ],
        }
    )


class TestRepricing:
    def test_the_price_comes_from_the_database_not_the_browser(self, cart):
        env = make_env(stocked(price=350))
        priced = run(cart.price_lines(env, [{"variantId": "v1", "quantity": 2}]))
        assert priced["lines"][0]["unitPrice"] == 350
        assert priced["subtotal"] == 700

    def test_a_quantity_beyond_stock_is_reduced_and_reported(self, cart):
        env = make_env(stocked(stock=3))
        priced = run(cart.price_lines(env, [{"variantId": "v1", "quantity": 9}]))
        assert priced["lines"][0]["quantity"] == 3
        assert priced["problems"][0]["reason"] == "reduced"
        assert priced["problems"][0]["available"] == 3

    def test_nothing_in_stock_drops_the_line(self, cart):
        env = make_env(stocked(stock=0))
        priced = run(cart.price_lines(env, [{"variantId": "v1", "quantity": 1}]))
        assert priced["lines"] == []
        assert priced["problems"][0]["reason"] == "out_of_stock"
        assert priced["subtotal"] == 0

    @pytest.mark.parametrize("kwargs", [{"status": "draft"}, {"status": "archived"}, {"enabled": 0}])
    def test_anything_no_longer_on_sale_reads_the_same_to_a_customer(self, cart, kwargs):
        env = make_env(stocked(**kwargs))
        priced = run(cart.price_lines(env, [{"variantId": "v1", "quantity": 1}]))
        assert priced["lines"] == []
        assert priced["problems"][0]["reason"] == "unavailable"

    def test_a_variant_that_no_longer_exists_is_not_an_error(self, cart):
        env = make_env(FakeDatabase())
        priced = run(cart.price_lines(env, [{"variantId": "gone", "quantity": 1}]))
        assert priced["problems"][0]["reason"] == "unavailable"


class TestDeliveryFees:
    def test_the_threshold_is_met_at_exactly_the_stated_amount(self, shipping):
        # Advertising free delivery over 1,000 and then charging on an order
        # of exactly 1,000 is an argument, not a rule.
        method = {"fee": 60, "freeThreshold": 1000}
        assert shipping.fee_for(method, 999) == 60
        assert shipping.fee_for(method, 1000) == 0
        assert shipping.fee_for(method, 1001) == 0

    def test_no_threshold_means_the_fee_always_applies(self, shipping):
        assert shipping.fee_for({"fee": 60, "freeThreshold": None}, 999999) == 60

    def test_disabled_methods_are_not_offered(self, shipping):
        methods = [
            {"method": "cvs_c2c", "label": "超商", "enabled": True, "fee": 60, "freeThreshold": None},
            {"method": "home", "label": "宅配", "enabled": False, "fee": 120, "freeThreshold": None},
        ]
        assert [quote["method"] for quote in shipping.quote(methods, 300)] == ["cvs_c2c"]

    @pytest.mark.parametrize("value", [-1, 1001, "60", 60.5, True])
    def test_a_fee_that_is_not_a_sane_whole_number_is_refused(self, shipping, value):
        with pytest.raises(ValueError):
            shipping.validate_fee(value)

    def test_an_absent_threshold_is_allowed_and_means_never_free(self, shipping):
        assert shipping.validate_free_threshold(None) is None
        assert shipping.validate_free_threshold("") is None


@pytest.fixture
def call():
    import main
    import migrations

    def run_request(request, database=None):
        migrations._applied_names = None
        worker = main.Default()
        worker.env = make_env(database or FakeDatabase())
        return asyncio.run(worker.fetch(request))

    return run_request


def storefront(path: str, method: str = "GET"):
    return FakeRequest(path, method, {"Origin": STOREFRONT_ORIGIN, "x-luma-app": "1"})


class TestCartRoute:
    def test_a_cart_without_the_app_header_cannot_be_priced(self, call):
        """The CSRF gate runs before the handler, and this is a POST."""

        plain = FakeRequest("/api/cart/validate", "POST", {"Origin": STOREFRONT_ORIGIN})
        assert call(plain).status == 403

    def test_a_malformed_body_is_a_client_error(self, call):
        assert call(storefront("/api/cart/validate", "POST")).status == 400

    def test_delivery_methods_are_public(self, call):
        assert call(FakeRequest("/api/shipping-methods")).status == 200
