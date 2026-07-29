"""The catalogue's validation rules and the admin routes that apply them.

Prices and stock end up in an amount charged to a card, so the tests that
matter most here are the ones about what the validators refuse.
"""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}


@pytest.fixture
def shop():
    from domain import shop as module

    return module


class TestSlugs:
    """Slugs go in customer-facing URLs, so they are the strictest field."""

    @pytest.mark.parametrize("value", ["soda-tote", "a", "a1", "long-ish-name-2"])
    def test_accepts_lowercase_words_joined_by_single_hyphens(self, shop, value):
        assert shop.validate_slug(value) == value

    def test_folds_case_and_surrounding_space(self, shop):
        assert shop.validate_slug("  Soda-Tote  ") == "soda-tote"

    @pytest.mark.parametrize("value", ["-lead", "trail-", "double--hyphen", "under_score", "空白 字", "", "a" * 65])
    def test_refuses_everything_else(self, shop, value):
        with pytest.raises(ValueError):
            shop.validate_slug(value)


class TestMoneyAndStock:
    def test_a_price_must_be_a_whole_number(self, shop):
        assert shop.validate_price(300) == 300

    @pytest.mark.parametrize("value", [300.0, "300", None, True])
    def test_a_price_that_is_not_an_int_is_refused_rather_than_coerced(self, shop, value):
        # int("0300") and int(300.7) both succeed and both mean someone is
        # about to be charged an amount nobody typed.
        with pytest.raises(ValueError):
            shop.validate_price(value)

    @pytest.mark.parametrize("value", [0, -1, 20001])
    def test_a_price_outside_the_gateway_range_is_refused(self, shop, value):
        # Zero would sail through checkout as a rounding artefact; the ceiling
        # is PAYUNi's per-order limit, so one line can never exceed it alone.
        with pytest.raises(ValueError):
            shop.validate_price(value)

    def test_stock_may_be_zero_but_not_negative(self, shop):
        assert shop.validate_stock(0) == 0
        with pytest.raises(ValueError):
            shop.validate_stock(-1)


class TestProductCreation:
    def test_creating_a_product_allocates_an_id_and_writes_the_row(self, shop):
        database = FakeDatabase({"SELECT COALESCE(MAX(position)": [{"last": 3}]})
        product_id = asyncio.run(
            shop.create_product(
                make_env(database), slug="canvas-bag", title="Canvas bag", description="", status="draft"
            )
        )

        assert shop.validate_product_id(product_id) == product_id
        insert, values = next((write for write in database.writes if "INSERT INTO products" in write[0]))
        assert values[:6] == (product_id, "canvas-bag", "Canvas bag", "", "draft", 4)


class TestWhatACustomerLearnsAboutStock:
    def test_a_low_count_is_shown(self, shop):
        variant = {"id": "v1", "title": "M", "price": 300, "stock": 2}
        assert shop.public_variant(variant)["stockLeft"] == 2

    def test_a_healthy_count_is_withheld(self, shop):
        """Publishing the exact figure hands anyone who polls it a sales ledger."""

        variant = {"id": "v1", "title": "M", "price": 300, "stock": 90}
        public = shop.public_variant(variant)
        assert public["inStock"] is True
        assert public["stockLeft"] is None

    def test_nothing_left_reads_as_out_of_stock(self, shop):
        variant = {"id": "v1", "title": "M", "price": 300, "stock": 0}
        public = shop.public_variant(variant)
        assert public["inStock"] is False
        assert public["stockLeft"] is None

    def test_the_payload_carries_no_internal_fields(self, shop):
        variant = {"id": "v1", "productId": "p1", "title": "M", "sku": "COST-12", "price": 300, "stock": 2}
        assert set(shop.public_variant(variant)) == {"id", "title", "price", "inStock", "stockLeft"}


class TestImageKeys:
    def test_the_stored_key_is_not_reachable_as_a_print_folder(self, shop):
        # IDENTIFIER_PATTERN has no underscore, so /images/ cannot reach these.
        assert shop.image_key(".jpg").startswith("_shop/")

    def test_the_public_path_is_derived_rather_than_guessed(self, shop):
        assert shop.image_path("_shop/abc.jpg") == "/shop-assets/abc.jpg"

    def test_a_key_outside_the_prefix_has_no_public_path(self, shop):
        assert shop.image_path("20260721_soda/a.jpg") is None

    @pytest.mark.parametrize("name", ["a.gif", "a.svg", "../a.jpg", "dir/a.jpg", "noextension"])
    def test_only_web_safe_photo_formats_are_accepted(self, shop, name):
        with pytest.raises(ValueError):
            shop.validate_image_suffix(name)


class TestImageOrdering:
    def test_reordering_updates_every_photo_position(self, shop):
        first, second = "a" * 18, "b" * 18
        database = FakeDatabase(
            {"SELECT id FROM product_images": [{"id": first}, {"id": second}]}
        )

        changed = asyncio.run(
            shop.reorder_images(make_env(database), "p" * 18, [second, first])
        )

        assert changed is True
        writes = [
            bindings
            for statement, bindings in database.writes
            if statement.startswith("UPDATE product_images SET position")
        ]
        assert writes == [(second, 0), (first, 1)]

    @pytest.mark.parametrize(
        "ordered",
        [
            ["a" * 18],
            ["a" * 18, "a" * 18],
            ["a" * 18, "c" * 18],
        ],
    )
    def test_reordering_requires_the_complete_photo_set(self, shop, ordered):
        database = FakeDatabase(
            {
                "SELECT id FROM product_images": [
                    {"id": "a" * 18},
                    {"id": "b" * 18},
                ]
            }
        )

        changed = asyncio.run(
            shop.reorder_images(make_env(database), "p" * 18, ordered)
        )

        assert changed is False
        assert not [
            statement
            for statement, _ in database.writes
            if statement.startswith("UPDATE product_images SET position")
        ]

    def test_admin_endpoint_persists_the_submitted_order(self):
        from api.admin import shop as shop_admin_api
        from shared.responses import Ctx
        from urllib.parse import parse_qs, urlsplit

        product_id, first, second = "p" * 18, "a" * 18, "b" * 18
        product = {
            "id": product_id,
            "slug": "soda-tote",
            "title": "蘇打托特包",
            "description": "",
            "status": "active",
            "position": 0,
            "created_at": 1,
            "updated_at": 1,
        }
        images = [
            {"id": first, "product_id": product_id, "r2_key": "_shop/a.jpg", "alt": "", "position": 0},
            {"id": second, "product_id": product_id, "r2_key": "_shop/b.jpg", "alt": "", "position": 1},
        ]
        database = FakeDatabase(
            {
                "SELECT * FROM products WHERE id": [product],
                "SELECT id FROM product_images": [{"id": first}, {"id": second}],
                "SELECT * FROM product_images": images,
            }
        )

        class JsonRequest(FakeRequest):
            async def json(self):
                return {"ids": [second, first]}

        request = JsonRequest(
            f"/api/products/{product_id}/images/order",
            "PUT",
            {"Origin": ADMIN_ORIGIN},
            host=ADMIN_HOST,
        )
        parts = urlsplit(request.url)
        response = asyncio.run(
            shop_admin_api.handle(
                Ctx(make_env(database), request, parts.path, parse_qs(parts.query))
            )
        )

        assert response.status == 200
        assert [
            bindings
            for statement, bindings in database.writes
            if statement.startswith("UPDATE product_images SET position")
        ] == [(second, 0), (first, 1)]


@pytest.fixture
def call():
    """Run one request through the admin Worker's entry point."""

    import admin_main
    from shared import migrations

    def run(request, answers=None):
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            FakeDatabase({**SIGNED_IN, **(answers or {})}),
            origins=ADMIN_ORIGIN,
            frontend=ADMIN_ORIGIN,
        )
        return asyncio.run(worker.fetch(request))

    return run


def signed_in(path: str, method: str = "GET"):
    return FakeRequest(
        path,
        method,
        {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
        host=ADMIN_HOST,
    )


class TestCatalogueRoutes:
    def test_listing_products_is_reachable(self, call):
        response = call(signed_in("/api/products"))
        assert response.status == 200
        assert response.json()["products"] == []

    def test_an_unknown_product_is_reported_as_missing(self, call):
        response = call(signed_in("/api/products/" + "a" * 18))
        assert response.status == 404

    def test_a_malformed_product_id_is_rejected_before_the_lookup(self, call):
        assert call(signed_in("/api/products/nope")).status == 400

    def test_reorder_is_not_read_as_a_product_id(self, call):
        """`order` sits where an id goes, so its route has to come first."""

        response = call(signed_in("/api/products/order", "PUT"))
        # It got to the handler rather than 404ing as a missing product; the
        # body is absent, so the handler rejects it as malformed.
        assert response.status == 400

    def test_an_unknown_variant_is_reported_as_missing(self, call):
        assert call(signed_in("/api/variants/" + "a" * 18, "DELETE")).status == 404

    def test_an_unknown_photo_is_reported_as_missing(self, call):
        assert call(signed_in("/api/images/" + "a" * 18, "DELETE")).status == 404

    def test_the_catalogue_is_closed_without_a_session(self, call):
        anonymous = FakeRequest(
            "/api/products", "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST
        )
        assert call(anonymous).status == 401
