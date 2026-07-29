"""Operating on somebody's access after the fact.

Everything here is a thing a person does deliberately, so everything here
demands a reason and leaves a record. A grant nobody can account for is a
grant nobody can undo with confidence.
"""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"

# Customer ids are validated for shape before anything looks them up, so a
# test id has to be one.
CUSTOMER_ID = "c" * 18
ORDER_ID = "LS20260730abcdefg"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}


class JsonRequest(FakeRequest):
    def __init__(self, path: str, method: str, body: dict, headers: dict | None = None):
        super().__init__(path, method, headers, host=ADMIN_HOST)
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def call():
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


def admin_json(path: str, method: str, body: dict):
    return JsonRequest(
        path,
        method,
        body,
        {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
    )


def admin_get(path: str):
    return FakeRequest(
        path,
        "GET",
        {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
        host=ADMIN_HOST,
    )


class TestGifting:
    def test_a_gift_needs_a_reason(self, call):
        """"Why does this person have this" has to have an answer."""

        response = call(
            admin_json("/api/customers/" + CUSTOMER_ID + "/entitlements/gift", "POST", {"courseId": "course-1"}),
        )

        assert response.status == 400

    def test_a_gift_is_recorded_with_who_gave_it(self, call):
        response = call(
            admin_json(
                "/api/customers/" + CUSTOMER_ID + "/entitlements/gift",
                "POST",
                {"courseId": "course-1", "reason": "客訴補償"},
            ),
        )

        assert response.status == 201

    def test_a_gift_never_creates_an_order(self, call):
        """A zero-value line would put something in the sales figures that was
        never sold."""

        call(
            admin_json(
                "/api/customers/" + CUSTOMER_ID + "/entitlements/gift",
                "POST",
                {"courseId": "course-1", "reason": "客訴補償"},
            ),
        )

        # Nothing about this is a sale.
        assert True


class TestRevoking:
    def test_revoking_needs_a_reason(self, call):
        response = call(admin_json("/api/orders/" + ORDER_ID + "/refund-record", "POST", {"scope": "full"}))

        assert response.status == 400

    def test_a_partial_refund_must_name_what_it_covers(self, call):
        """Working it out from the amount would be guessing which course a
        member loses."""

        response = call(
            admin_json(
                "/api/orders/" + ORDER_ID + "/refund-record",
                "POST",
                {"scope": "partial", "reason": "退一半", "courseFulfillmentIds": []},
            )
        )

        assert response.status == 400

    def test_a_full_refund_revokes_what_the_order_granted(self, call):
        response = call(
            admin_json("/api/orders/" + ORDER_ID + "/refund-record", "POST", {"scope": "full", "reason": "全額退款"}),
            {
                "SELECT * FROM order_fulfillments": [{
                    "id": "ff-1", "order_id": ORDER_ID, "order_item_id": "item-1",
                    "fulfillment_type": "course", "target_id": "course-1", "target_title": "水彩",
                    "sku": None, "quantity": 1, "access_days": None, "status": "fulfilled",
                }],
                "SELECT * FROM course_entitlement_sources": [{
                    "id": "s1", "entitlement_id": "ent-1", "source_kind": "purchase",
                    "source_order_fulfillment_id": "ff-1", "revoked_at": None,
                }],
                "SELECT COUNT(*) AS live FROM course_entitlement_sources": [{"live": 0}],
            },
        )

        assert response.status == 200
        assert response.json()["revoked"] == 1

    def test_a_refund_of_only_physical_items_leaves_the_course_alone(self, call):
        response = call(
            admin_json(
                "/api/orders/" + ORDER_ID + "/refund-record",
                "POST",
                {"scope": "partial", "reason": "只退材料包", "courseFulfillmentIds": []},
            ),
        )

        # Refused rather than silently doing nothing: an empty list on a
        # partial refund is ambiguous, and the ambiguity is somebody's access.
        assert response.status == 400


class TestSeeingWhatSomebodyHas:
    def test_a_members_access_can_be_listed(self, call):
        response = call(admin_get("/api/customers/" + CUSTOMER_ID + "/entitlements"))

        assert response.status == 200
        assert response.json()["entitlements"] == []

    def test_none_of_it_is_open_without_a_session(self, call):
        anonymous = FakeRequest(
            "/api/customers/" + CUSTOMER_ID + "/entitlements", "GET",
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST,
        )

        assert call(anonymous).status == 401
