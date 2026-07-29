"""The catalogue's validation rules and the admin routes that apply them.

Prices and stock end up in an amount charged to a card, so the tests that
matter most here are the ones about what the validators refuse.
"""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}


class JsonRequest(FakeRequest):
    def __init__(self, path: str, method: str, body: dict, headers: dict | None = None, host: str = ADMIN_HOST):
        super().__init__(path, method, headers, host=host)
        self._body = body

    async def json(self):
        return self._body


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

    def test_single_offer_is_inserted_as_the_default_without_a_visible_title(self, shop):
        database = FakeDatabase({"SELECT COALESCE(MAX(position)": [{"last": -1}]})

        asyncio.run(
            shop.create_product_with_default_offer(
                make_env(database), slug="canvas-bag", title="Canvas bag", description="", status="draft",
                sku="CANVAS-1", price=300, stock=4, enabled=False,
            )
        )

        insert, values = next((write for write in database.writes if "INSERT INTO product_variants" in write[0]))
        assert "is_default" in insert
        assert values[2:] == ("", "CANVAS-1", 300, 4, 0, 0, 1)


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

    def test_a_default_offer_hides_its_internal_empty_title_and_needs_no_choice(self, shop):
        product = {"slug": "canvas-bag", "title": "Canvas bag", "description": ""}
        variants = [{"id": "v1", "title": "", "price": 300, "stock": 4, "enabled": True, "isDefault": True}]

        public = shop.public_detail(product, variants, [], [])

        assert public["requiresOfferSelection"] is False
        assert public["variants"][0]["title"] is None

    def test_multiple_offers_require_a_customer_choice(self, shop):
        variants = [
            {"id": "v1", "title": "M", "price": 300, "stock": 4, "enabled": True, "isDefault": False},
            {"id": "v2", "title": "L", "price": 300, "stock": 4, "enabled": True, "isDefault": False},
        ]

        assert shop.public_detail({"slug": "shirt", "title": "Shirt", "description": ""}, variants, [], [])["requiresOfferSelection"] is True


class TestOfferMode:
    def test_default_marker_not_variant_count_selects_single_mode(self, shop):
        assert shop.sales_mode([{"isDefault": True}, {"isDefault": False}]) == "single"
        assert shop.sales_mode([{"isDefault": False}]) == "multi"


class TestOfferLifecycle:
    def test_single_to_multi_keeps_the_existing_offer_id_and_sales_values(self, shop):
        offer_id, product_id = "v" * 18, "p" * 18
        database = FakeDatabase(
            {
                "SELECT * FROM product_variants WHERE product_id": [
                    {
                        "id": offer_id,
                        "product_id": product_id,
                        "title": "",
                        "sku": "CANVAS-1",
                        "price": 300,
                        "stock": 4,
                        "position": 0,
                        "enabled": 1,
                        "is_default": 1,
                    }
                ]
            }
        )

        assert asyncio.run(shop.convert_default_offer_to_multi(make_env(database), product_id, title="標準版")) is True

        update, bindings = next(write for write in database.writes if "UPDATE product_variants SET title" in write[0])
        assert "is_default = 0" in update
        assert bindings == (offer_id, "標準版")

    def test_an_active_product_cannot_lose_its_last_enabled_offer(self, shop):
        product_id, offer_id = "p" * 18, "v" * 18
        assert asyncio.run(
            shop.can_be_active(make_env(FakeDatabase()), product_id, changing_offer_id=offer_id, offer_enabled=False)
        ) is False

    def test_an_active_product_can_keep_another_enabled_offer(self, shop):
        product_id, offer_id = "p" * 18, "v" * 18
        database = FakeDatabase({"SELECT id FROM product_variants": [{"id": "other" * 4}]})

        assert asyncio.run(
            shop.can_be_active(make_env(database), product_id, changing_offer_id=offer_id, offer_enabled=False)
        ) is True


class TestDefaultOfferMigration:
    def test_migration_adds_marker_index_before_backfilling_only_single_offer_products(self):
        from shared import migrations

        migration = next(item for item in migrations.MIGRATIONS if item["name"] == "0027_add_default_product_offers")
        database = FakeDatabase()

        asyncio.run(migrations._apply_one(make_env(database), migration))

        statements = [statement for statement, _ in database.writes]
        assert any("ALTER TABLE product_variants ADD COLUMN is_default" in statement for statement in statements)
        assert any("idx_product_variants_one_default" in statement and "WHERE is_default = 1" in statement for statement in statements)
        backfill = next(statement for statement in statements if "UPDATE product_variants SET is_default = 1" in statement)
        assert "GROUP BY product_id HAVING COUNT(*) = 1" in backfill


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


class TestOfferAdminValidation:
    def test_an_active_product_cannot_be_created_with_a_disabled_default_offer(self):
        from api.admin import shop as shop_admin_api
        from shared.responses import Ctx
        from urllib.parse import parse_qs, urlsplit

        request = JsonRequest(
            "/api/products",
            "POST",
            {"slug": "canvas-bag", "title": "Canvas bag", "status": "active", "price": 300, "stock": 4, "enabled": False},
        )
        parts = urlsplit(request.url)
        response = asyncio.run(
            shop_admin_api.handle(Ctx(make_env(FakeDatabase()), request, parts.path, parse_qs(parts.query)))
        )

        assert response.status == 409
        assert "至少需要一筆啟用" in response.json()["error"]

    def test_default_offer_cannot_be_deleted_through_the_generic_variant_endpoint(self):
        from api.admin import shop as shop_admin_api
        from shared.responses import Ctx
        from urllib.parse import parse_qs, urlsplit

        product_id, variant_id = "p" * 18, "v" * 18
        database = FakeDatabase(
            {
                "SELECT * FROM product_variants WHERE id": [
                    {"id": variant_id, "product_id": product_id, "title": "", "sku": "", "price": 300, "stock": 4, "position": 0, "enabled": 1, "is_default": 1}
                ],
                "SELECT * FROM products WHERE id": [
                    {"id": product_id, "slug": "canvas-bag", "title": "Canvas bag", "description": "", "status": "draft", "position": 0, "created_at": 1, "updated_at": 1}
                ],
            }
        )
        request = FakeRequest(f"/api/variants/{variant_id}", "DELETE", host=ADMIN_HOST)
        parts = urlsplit(request.url)
        response = asyncio.run(
            shop_admin_api.handle(Ctx(make_env(database), request, parts.path, parse_qs(parts.query)))
        )

        assert response.status == 409
        assert "不能刪除" in response.json()["error"]
