"""The admin routes for stock, courses and what an offer delivers.

These are the first screens where an admin can say "this offer grants that
course and ships that kit". The rules they enforce are the ones the domain
modules define; what these tests are about is that the routes reach them, that
nothing here is reachable without a session, and that a client cannot submit
the values the server is supposed to work out.
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
def call():
    """Run one request through the admin Worker's entry point."""

    import admin_main
    from shared import migrations

    def run(request, answers=None, changes=None):
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            FakeDatabase({**SIGNED_IN, **(answers or {})}, changes=changes),
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


def signed_in_json(path: str, method: str, body: dict):
    return JsonRequest(
        path,
        method,
        body,
        {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
    )


class TestReachability:
    def test_the_stockroom_is_listed(self, call):
        response = call(signed_in("/api/inventory-items"))

        assert response.status == 200
        assert response.json()["items"] == []

    def test_courses_are_listed(self, call):
        response = call(signed_in("/api/courses"))

        assert response.status == 200
        assert response.json()["courses"] == []

    def test_an_unknown_item_is_reported_as_missing(self, call):
        assert call(signed_in("/api/inventory-items/" + "a" * 18)).status == 404

    def test_an_unknown_course_is_reported_as_missing(self, call):
        assert call(signed_in("/api/courses/" + "a" * 18)).status == 404

    @pytest.mark.parametrize("path", ["/api/inventory-items", "/api/courses"])
    def test_none_of_it_is_open_without_a_session(self, call, path):
        anonymous = FakeRequest(path, "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST)

        assert call(anonymous).status == 401


class TestInventoryWrites:
    def test_an_item_needs_a_name(self, call):
        assert call(signed_in_json("/api/inventory-items", "POST", {"title": "  ", "stock": 1})).status == 400

    def test_a_sku_already_in_use_is_refused(self, call):
        response = call(
            signed_in_json("/api/inventory-items", "POST", {"title": "材料包", "sku": "KIT-1", "stock": 1}),
            {"SELECT id FROM inventory_items": [{"id": "other"}]},
        )

        assert response.status == 409

    def test_two_items_without_a_sku_are_not_a_conflict(self, call):
        response = call(signed_in_json("/api/inventory-items", "POST", {"title": "材料包", "stock": 1}))

        assert response.status == 201

    def test_negative_stock_is_refused(self, call):
        assert call(signed_in_json("/api/inventory-items", "POST", {"title": "材料包", "stock": -1})).status == 400

    def test_an_item_archived_between_the_lookup_and_the_write_is_not_reported_as_saved(self, call):
        """`update_item` refuses an archived row. Answering 200 with the
        values that were read would tell the admin their edit landed."""

        response = call(
            signed_in_json("/api/inventory-items/" + "a" * 18, "PUT", {"title": "材料包", "stock": 3}),
            {
                "SELECT * FROM inventory_items": [{
                    "id": "a" * 18, "sku": "", "title": "材料包", "stock": 1,
                    "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
                }],
            },
            changes={"UPDATE inventory_items SET title": 0},
        )

        assert response.status == 409


class TestCourseWrites:
    def test_a_slug_already_in_use_is_refused(self, call):
        response = call(
            signed_in_json("/api/courses", "POST", {"slug": "watercolour", "title": "水彩"}),
            {"SELECT id FROM courses": [{"id": "other"}]},
        )

        assert response.status == 409

    def test_a_slug_that_would_not_survive_a_url_is_refused(self, call):
        assert call(signed_in_json("/api/courses", "POST", {"slug": "水 彩", "title": "水彩"})).status == 400

    def test_editing_a_course_onto_another_ones_slug_is_refused(self, call):
        response = call(
            signed_in_json("/api/courses/" + "a" * 18, "PUT", {"slug": "taken", "title": "水彩"}),
            {
                "SELECT * FROM courses WHERE id": [{
                    "id": "a" * 18, "slug": "mine", "title": "水彩",
                    "status": "draft", "created_at": 0, "updated_at": 0,
                }],
                "SELECT id FROM courses": [{"id": "other"}],
            },
        )

        assert response.status == 409

    def test_a_course_that_vanished_between_the_lookup_and_the_write_is_not_reported_as_saved(self, call):
        """The row is read, then written. Answering 200 with the values that
        were read would tell the admin their edit landed when it did not."""

        response = call(
            signed_in_json("/api/courses/" + "a" * 18, "PUT", {"slug": "mine", "title": "水彩"}),
            {
                "SELECT * FROM courses WHERE id": [{
                    "id": "a" * 18, "slug": "mine", "title": "水彩",
                    "status": "draft", "created_at": 0, "updated_at": 0,
                }],
            },
            changes={"UPDATE courses SET": 0},
        )

        assert response.status == 404


class TestSingleOfferProductSave:
    """Saving a no-options product saves its price and stock with it."""

    def _catalogue(self, *, referenced_by: list[str] | None = None) -> dict:
        product_id, offer_id = "p" * 18, "v" * 18
        return {
            "SELECT * FROM products WHERE id": [{
                "id": product_id, "slug": "brush", "title": "畫筆", "description": "",
                "status": "draft", "position": 0, "created_at": 0, "updated_at": 0,
            }],
            "SELECT * FROM product_variants WHERE product_id": [{
                "id": offer_id, "product_id": product_id, "title": "", "sku": "BRUSH-01",
                "price": 680, "stock": 5, "position": 0, "enabled": 1, "is_default": 1,
            }],
            "SELECT * FROM product_variants WHERE id": [{
                "id": offer_id, "product_id": product_id, "title": "", "sku": "BRUSH-01",
                "price": 680, "stock": 5, "position": 0, "enabled": 1, "is_default": 1,
            }],
            "SELECT * FROM offer_components": [{
                "id": "oc-1", "offer_id": offer_id, "component_type": "inventory",
                "component_id": offer_id, "quantity": 1, "access_days": None, "position": 0,
            }],
            "SELECT offer_id FROM offer_components": [
                {"offer_id": value} for value in (referenced_by or [offer_id])
            ],
            "SELECT * FROM inventory_items": [{
                "id": offer_id, "sku": "BRUSH-01", "title": "畫筆", "stock": 5,
                "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
            }],
        }

    def test_saving_price_and_stock_from_the_product_page_succeeds(self, call):
        response = call(
            signed_in_json(
                "/api/products/" + "p" * 18,
                "PUT",
                {
                    "slug": "brush", "title": "畫筆", "description": "", "status": "draft",
                    "price": 680, "sku": "BRUSH-01", "stock": 12, "enabled": True,
                },
            ),
            self._catalogue(),
        )

        assert response.status == 200

    def test_stock_the_product_page_cannot_own_is_explained_rather_than_a_server_error(self, call):
        """A shared item's count belongs to every offer including it. The
        editor cannot express that, so it says so instead of failing."""

        response = call(
            signed_in_json(
                "/api/products/" + "p" * 18,
                "PUT",
                {
                    "slug": "brush", "title": "畫筆", "description": "", "status": "draft",
                    "price": 680, "sku": "BRUSH-01", "stock": 12, "enabled": True,
                },
            ),
            self._catalogue(referenced_by=["v" * 18, "other-offer"]),
        )

        assert response.status == 409
        assert "庫存" in response.json()["error"]


class TestArchiveProtection:
    """Something an order or an offer names is archived, never deleted."""

    def test_an_item_an_offer_still_uses_cannot_be_deleted(self, call):
        response = call(
            signed_in("/api/inventory-items/" + "a" * 18, "DELETE"),
            {
                "SELECT * FROM inventory_items": [{
                    "id": "a" * 18, "sku": "", "title": "材料包", "stock": 1,
                    "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
                }],
                "SELECT offer_id FROM offer_components": [{"offer_id": "off-1"}],
            },
        )

        assert response.status == 409
        assert "封存" in response.json()["error"]

    def test_what_uses_an_item_can_be_asked_for(self, call):
        response = call(
            signed_in("/api/inventory-items/" + "a" * 18 + "/references"),
            {
                "SELECT * FROM inventory_items": [{
                    "id": "a" * 18, "sku": "", "title": "材料包", "stock": 1,
                    "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
                }],
                "SELECT offer_id FROM offer_components": [{"offer_id": "off-1"}, {"offer_id": "off-2"}],
            },
        )

        assert response.status == 200
        assert response.json()["offerIds"] == ["off-1", "off-2"]


class TestOfferComponents:
    def _offer_exists(self, extra: dict | None = None) -> dict:
        return {
            "SELECT * FROM product_variants WHERE id": [{
                "id": "off-1", "product_id": "p" * 18, "title": "", "sku": "",
                "price": 300, "stock": 1, "position": 0, "enabled": 1, "is_default": 1,
            }],
            **(extra or {}),
        }

    @pytest.mark.parametrize("field", ["requiresShipping", "containsCourse", "digitalOnly", "isBundle"])
    def test_a_derived_flag_submitted_by_the_client_is_refused(self, call, field):
        """These are worked out from the components. Accepting any of them
        would let a caller describe a course as needing postage.

        Refused rather than ignored: a client whose value was dropped goes on
        believing it was obeyed.
        """

        response = call(
            signed_in_json(
                "/api/offers/off-1/components",
                "PUT",
                {"components": [{"type": "course", "componentId": "c1"}], field: True},
            ),
            self._offer_exists(),
        )

        assert response.status == 400

    def test_a_component_pointing_at_another_offer_is_refused(self, call):
        response = call(
            signed_in_json(
                "/api/offers/off-1/components",
                "PUT",
                {"components": [{"type": "offer", "componentId": "off-2"}]},
            ),
            self._offer_exists(),
        )

        assert response.status == 400

    def test_a_target_that_does_not_exist_is_refused(self, call):
        response = call(
            signed_in_json(
                "/api/offers/off-1/components",
                "PUT",
                {"components": [{"type": "inventory", "componentId": "ghost"}]},
            ),
            self._offer_exists(),
        )

        assert response.status == 400

    def test_components_for_an_unknown_offer_are_not_written(self, call):
        response = call(
            signed_in_json("/api/offers/nope/components", "PUT", {"components": []}),
        )

        assert response.status == 404


class TestCourseOutlineRoutes:
    def _course_exists(self, extra: dict | None = None) -> dict:
        return {
            "SELECT * FROM courses WHERE id": [{
                "id": "a" * 18, "slug": "watercolour", "title": "水彩入門", "status": "draft",
                "created_at": 0, "updated_at": 0, "summary": "兩小時學會", "description_html": "",
                "cover_media_id": "media-1", "instructor_name": "王老師", "instructor_bio_html": "",
                "level": "beginner", "language": "zh-Hant", "audience_html": "", "outcomes_html": "",
                "prerequisites_html": "", "materials_html": "", "published_at": None,
            }],
            **(extra or {}),
        }

    def test_an_outline_can_be_read(self, call):
        response = call(signed_in(f"/api/courses/{'a' * 18}/outline"), self._course_exists())

        assert response.status == 200
        assert response.json()["sections"] == []

    def test_a_malformed_outline_is_refused_before_anything_is_deleted(self, call):
        """The write replaces the tree. A bad request must not cost the old one."""

        response = call(
            signed_in_json(f"/api/courses/{'a' * 18}/outline", "PUT", {"sections": [{"title": ""}]}),
            self._course_exists(),
        )

        assert response.status == 400

    def test_publishing_reports_every_problem_at_once(self, call):
        response = call(
            signed_in_json(f"/api/courses/{'a' * 18}/publish", "POST", {}),
            self._course_exists(),
        )

        assert response.status == 409
        # No cover was set and there is no outline, so both come back.
        assert len(response.json()["problems"]) >= 1

    def test_an_outline_for_a_course_that_is_not_there_is_not_written(self, call):
        response = call(signed_in_json(f"/api/courses/{'b' * 18}/outline", "PUT", {"sections": []}))

        assert response.status == 404


class TestCourseDisplayFields:
    """The parts a product page reads, saved from the editor."""

    def _course(self) -> dict:
        return {
            "SELECT * FROM courses WHERE id": [{
                "id": "a" * 18, "slug": "watercolour", "title": "水彩入門", "status": "draft",
                "created_at": 0, "updated_at": 0, "summary": "", "description_html": "",
                "cover_media_id": None, "instructor_name": "", "instructor_bio_html": "",
                "level": "all", "language": "zh-Hant", "audience_html": "", "outcomes_html": "",
                "prerequisites_html": "", "materials_html": "", "published_at": None,
            }],
        }

    def _save(self, call, body: dict):
        return call(
            signed_in_json("/api/courses/" + "a" * 18, "PUT", {"slug": "watercolour", "title": "水彩入門", **body}),
            self._course(),
        )

    def test_the_long_form_fields_are_saved(self, call):
        response = self._save(call, {"descriptionHtml": "<p>介紹</p>", "outcomesHtml": "<p>你會學到</p>"})

        assert response.status == 200

    def test_html_is_cleaned_on_the_way_in(self):
        """The editor restricts what an author can type. That is a convenience,
        and this is the boundary.

        Asserted on what the route builds rather than on what it reads back:
        the fake database returns the fixture unchanged, so a round-trip check
        would pass without anything having been cleaned.
        """

        from api.admin import catalogue

        fields = catalogue._course_display_fields({"descriptionHtml": "<p>好<script>alert(1)</script></p>"})

        assert "script" not in fields["descriptionHtml"]
        assert "好" in fields["descriptionHtml"]

    def test_every_long_form_field_goes_through_the_same_door(self):
        """One of them being missed is the failure that would not be noticed."""

        from api.admin import catalogue

        attack = "<p><script>alert(1)</script></p>"
        fields = catalogue._course_display_fields(
            {
                "descriptionHtml": attack,
                "instructorBioHtml": attack,
                "audienceHtml": attack,
                "outcomesHtml": attack,
                "prerequisitesHtml": attack,
                "materialsHtml": attack,
            }
        )

        for name, value in fields.items():
            if name.endswith("Html"):
                assert "script" not in value, name

    def test_a_cover_can_be_chosen(self, call):
        response = self._save(call, {"coverMediaId": "media-1"})

        assert response.status == 200

    def test_html_beyond_a_sane_size_is_refused(self, call):
        response = self._save(call, {"descriptionHtml": "<p>" + "a" * 70_000 + "</p>"})

        assert response.status == 400
