"""What the cart accepts from a browser, and what it recomputes.

The cart arrives from localStorage, so every number in it is a request rather
than a fact. These tests are mostly about the ones that get refused.
"""

import asyncio

import pytest

from conftest import FakeDatabase, FakeRequest, STOREFRONT_ORIGIN, make_env


@pytest.fixture
def cart():
    from domain import cart as module

    return module


@pytest.fixture
def shipping():
    from domain import shipping as module

    return module


def run(coroutine):
    return asyncio.run(coroutine)


class TestReadingTheBrowsersCart:
    def test_a_normal_cart_survives_intact(self, cart):
        lines = cart.parse_lines([{"variantId": "v1", "quantity": 2}])
        assert lines == [{"variantId": "v1", "offerId": "v1", "quantity": 2}]

    def test_repeated_variants_are_merged_rather_than_refused(self, cart):
        """Two lines for one variant is a client-side merge that did not happen."""

        lines = cart.parse_lines([{"variantId": "v1", "quantity": 2}, {"variantId": "v1", "quantity": 3}])
        assert lines == [{"variantId": "v1", "offerId": "v1", "quantity": 5}]

    def test_the_shop_does_not_decide_how_many_someone_may_buy(self, cart):
        """Whatever is on the shelf is for sale. `price_lines` reduces the line
        to the stock and says "only N left"; nothing here second-guesses it."""

        lines = cart.parse_lines([{"variantId": "v1", "quantity": 500}])
        assert lines[0]["quantity"] == 500

    def test_a_merge_is_still_bounded_by_what_the_shop_could_hold(self, cart):
        """Not a policy — the point past which the number is a broken client."""

        half = cart.MAX_QUANTITY
        lines = cart.parse_lines([{"variantId": "v1", "quantity": half}, {"variantId": "v1", "quantity": half}])
        assert lines[0]["quantity"] == cart.MAX_QUANTITY

    @pytest.mark.parametrize(
        "raw",
        [
            "not a list",
            [{"variantId": "v1"}],
            [{"variantId": "v1", "quantity": 0}],
            [{"variantId": "v1", "quantity": -3}],
            [{"variantId": "v1", "quantity": 100001}],
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


def stocked(*, status="active", enabled=1, stock=10, price=300, is_default=0, title="M"):
    """A database that answers with one product sold as one physical item.

    Stock lives on the InventoryItem now, so a "one variant" fixture is really
    an offer with a single inventory component behind it. The backfill gave
    that item the offer's own id, which is why both are "v1".
    """

    product = {
        "id": "p1",
        "slug": "soda-tote",
        "title": "蘇打托特包",
        "description": "",
        "status": status,
        "position": 0,
        "created_at": 1,
        "updated_at": 1,
    }
    return FakeDatabase(
        {
            "FROM product_variants v JOIN products p": [
                {
                    "id": "v1",
                    "product_id": "p1",
                    "title": title,
                    "price": price,
                    "enabled": enabled,
                    "product_status": status,
                    "product_title": "蘇打托特包",
                }
            ],
            "SELECT * FROM offer_components": [
                {
                    "id": "oc-v1",
                    "offer_id": "v1",
                    "component_type": "inventory",
                    "component_id": "v1",
                    "quantity": 1,
                    "access_days": None,
                    "position": 0,
                }
            ],
            "SELECT * FROM inventory_items": [
                {
                    "id": "v1",
                    "title": "蘇打托特包",
                    "sku": "",
                    "stock": stock,
                    "enabled": enabled,
                    "archived_at": None,
                }
            ],
            "FROM product_variants WHERE id": [
                {
                    "id": "v1",
                    "product_id": "p1",
                    "title": title,
                    "sku": "",
                    "price": price,
                    "stock": stock,
                    "position": 0,
                    "enabled": enabled,
                    "is_default": is_default,
                }
            ],
            "FROM products WHERE id": [product],
        }
    )


class TestRepricing:
    def test_the_price_comes_from_the_database_not_the_browser(self, cart):
        env = make_env(stocked(price=350))
        priced = run(cart.price_lines(env, [{"variantId": "v1", "quantity": 2}]))
        assert priced["lines"][0]["unitPrice"] == 350
        assert priced["subtotal"] == 700

    def test_a_default_offer_keeps_the_existing_variant_id_for_price_and_stock_validation(self, cart):
        env = make_env(stocked(price=350, stock=3, is_default=1, title=""))

        priced = run(cart.price_lines(env, [{"variantId": "v1", "quantity": 9}]))

        assert priced["lines"] == [
            {
                "variantId": "v1",
                "offerId": "v1",
                "productSlug": "soda-tote",
                "productTitle": "蘇打托特包",
                "variantTitle": "",
                "offerTitle": None,
                "imagePath": None,
                "unitPrice": 350,
                "quantity": 3,
                "lineTotal": 1050,
                "containsCourse": False,
                "requiresShipping": True,
                "components": [
                    {
                        "type": "inventory",
                        "targetId": "v1",
                        "targetTitle": "蘇打托特包",
                        "sku": "",
                        "quantity": 1,
                        # Resolved against what was asked for, before stock
                        # cut the line down to what is actually there.
                        "requiredQuantity": 9,
                        "availableStock": 3,
                    }
                ],
                "stockLeft": 0,
            }
        ]
        assert priced["problems"] == [
            {"variantId": "v1", "offerId": "v1", "title": "蘇打托特包", "reason": "reduced", "available": 3}
        ]

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
    from shared import migrations

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


class TestOfferIdCompatibility:
    """`variantId` and `offerId` are the same value under two names.

    A cart saved in localStorage months ago still says `variantId`, and that
    browser has no idea a rename happened. Both are accepted; disagreeing with
    yourself is not.
    """

    def test_the_old_name_is_still_read(self, cart):
        assert cart.parse_lines([{"variantId": "off-1", "quantity": 1}]) == [
            {"variantId": "off-1", "offerId": "off-1", "quantity": 1}
        ]

    def test_the_new_name_is_read_too(self, cart):
        assert cart.parse_lines([{"offerId": "off-1", "quantity": 1}]) == [
            {"variantId": "off-1", "offerId": "off-1", "quantity": 1}
        ]

    def test_both_names_agreeing_is_fine(self, cart):
        assert cart.parse_lines([{"variantId": "off-1", "offerId": "off-1", "quantity": 1}])[0]["offerId"] == "off-1"

    def test_both_names_disagreeing_is_refused(self, cart):
        """Guessing which one the customer meant is how you charge for the
        wrong thing."""

        with pytest.raises(cart.CartError):
            cart.parse_lines([{"variantId": "off-1", "offerId": "off-2", "quantity": 1}])


class TestQuotingAnOffer:
    """Pricing now runs through `resolve_offer`, the same call checkout makes."""

    def _database(self, components: list[dict], *, stock: int = 12, price: int = 3980):
        return FakeDatabase(
            {
                "FROM product_variants v JOIN products p": [{
                    "id": "off-1", "product_id": "prod-1", "title": "", "price": price, "enabled": 1,
                    "product_status": "active", "product_title": "水彩完整套組",
                }],
                "SELECT * FROM offer_components": components,
                "SELECT * FROM inventory_items": [{
                    "id": "kit-1", "title": "水彩材料包", "sku": "KIT-1", "stock": stock,
                    "enabled": 1, "archived_at": None,
                }],
                "SELECT * FROM courses": [{"id": "course-1", "title": "水彩花卉入門", "status": "published"}],
                "SELECT * FROM products WHERE id": [{
                    "id": "prod-1", "slug": "watercolour-set", "title": "水彩完整套組", "description": "",
                    "status": "active", "position": 0, "created_at": 0, "updated_at": 0,
                }],
            }
        )

    def _component(self, type_: str, component_id: str, quantity: int = 1, position: int = 0):
        return {
            "id": f"oc-{component_id}", "offer_id": "off-1", "component_type": type_,
            "component_id": component_id, "quantity": quantity, "access_days": None, "position": position,
        }

    def test_a_course_only_cart_needs_no_delivery(self, cart):
        quote = run(
            cart.price_lines(
                make_env(self._database([self._component("course", "course-1")])),
                [{"variantId": "off-1", "offerId": "off-1", "quantity": 1}],
            )
        )

        assert quote["requiresShipping"] is False
        assert quote["containsCourse"] is True
        assert quote["shippingSubtotal"] == 0

    def test_only_lines_that_ship_count_towards_free_delivery(self, cart):
        """A digital line must not push a cart over a physical threshold."""

        quote = run(
            cart.price_lines(
                make_env(self._database([self._component("inventory", "kit-1")])),
                [{"variantId": "off-1", "offerId": "off-1", "quantity": 1}],
            )
        )

        assert quote["requiresShipping"] is True
        assert quote["shippingSubtotal"] == quote["subtotal"]

    def test_a_mixed_offer_counts_in_full_towards_delivery(self, cart):
        """Its price cannot be split between the course and the kit without
        inventing a number nobody set."""

        quote = run(
            cart.price_lines(
                make_env(
                    self._database(
                        [self._component("course", "course-1"), self._component("inventory", "kit-1", position=1)]
                    )
                ),
                [{"variantId": "off-1", "offerId": "off-1", "quantity": 1}],
            )
        )

        assert quote["shippingSubtotal"] == 3980
        assert quote["containsCourse"] is True

    def test_a_course_line_cannot_be_bought_more_than_once(self, cart):
        quote = run(
            cart.price_lines(
                make_env(self._database([self._component("course", "course-1")])),
                [{"variantId": "off-1", "offerId": "off-1", "quantity": 3}],
            )
        )

        assert [problem["reason"] for problem in quote["problems"]] == ["quantity_not_allowed"]
        assert quote["lines"][0]["quantity"] == 1

    def test_stock_is_judged_on_what_the_line_actually_needs(self, cart):
        """Two kits per offer and three offers is six kits, not three."""

        quote = run(
            cart.price_lines(
                make_env(self._database([self._component("inventory", "kit-1", quantity=2)], stock=5)),
                [{"variantId": "off-1", "offerId": "off-1", "quantity": 3}],
            )
        )

        assert [problem["reason"] for problem in quote["problems"]] == ["reduced"]
        assert quote["lines"][0]["quantity"] == 2

    def test_an_offer_whose_contents_vanished_is_not_quoted(self, cart):
        database = self._database([self._component("inventory", "ghost")])

        quote = run(
            cart.price_lines(make_env(database), [{"variantId": "off-1", "offerId": "off-1", "quantity": 1}])
        )

        assert [problem["reason"] for problem in quote["problems"]] == ["component_unavailable"]
        assert quote["lines"] == []
