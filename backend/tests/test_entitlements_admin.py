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
        database = FakeDatabase({**SIGNED_IN, **(answers or {})}, changes=changes)
        # Hung off the fixture so a test about *what was asked of the database*
        # can reach it. Revoking is one of those: the guard that keeps this away
        # from a purchase lives in the statement, not in the answer.
        run.database = database
        worker.env = make_env(database, origins=ADMIN_ORIGIN, frontend=ADMIN_ORIGIN)
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


class TestReIssuing:
    """Handing over a course the member should already have had.

    Apart from a gift because they are different claims about what happened:
    the shop choosing to give something away, versus the shop failing to
    deliver and putting it right.
    """

    def grant(self, call, body):
        return call(
            admin_json("/api/customers/" + CUSTOMER_ID + "/entitlements/grant", "POST", body),
        )

    def test_a_re_issue_needs_a_reason(self, call):
        response = self.grant(call, {"courseId": "course-1"})

        assert response.status == 400

    def test_it_is_written_down_as_a_re_issue_and_not_a_gift(self, call):
        """The two look identical in the database except for this, and the
        accounts read differently for each."""

        response = self.grant(call, {"courseId": "course-1", "reason": "付款當下漏開通"})

        assert response.status == 201
        inserted = [
            bindings for sql, bindings in call.database.writes
            if "INSERT INTO course_entitlement_sources" in sql
        ]
        assert inserted and inserted[0][2] == "manual"

    def test_it_can_carry_the_term_the_member_actually_bought(self, call):
        """Re-issuing a thirty-day course as a permanent one would quietly
        upgrade what they paid for."""

        self.grant(call, {"courseId": "course-1", "reason": "補發", "accessDays": 30})

        created = [
            bindings for sql, bindings in call.database.writes
            if "INSERT INTO course_entitlements (" in sql
        ]
        assert created and created[0][4] == 30

    def test_a_blank_term_means_permanent_rather_than_missing(self, call):
        self.grant(call, {"courseId": "course-1", "reason": "補發", "accessDays": ""})

        created = [
            bindings for sql, bindings in call.database.writes
            if "INSERT INTO course_entitlements (" in sql
        ]
        assert created and created[0][4] is None

    def test_a_nonsense_term_is_refused(self, call):
        """A box that means days, mistyped, must not produce a grant lasting
        until the next century."""

        assert self.grant(call, {"courseId": "c1", "reason": "補發", "accessDays": 99999}).status == 400
        assert self.grant(call, {"courseId": "c1", "reason": "補發", "accessDays": 0}).status == 400
        assert self.grant(call, {"courseId": "c1", "reason": "補發", "accessDays": "三十"}).status == 400

    def test_re_issuing_to_somebody_who_already_holds_it_does_not_extend_them(self, call):
        """Running it twice, or re-issuing a course somebody is part way
        through, must not hand them more time than they bought."""

        response = call(
            admin_json(
                "/api/customers/" + CUSTOMER_ID + "/entitlements/grant",
                "POST",
                {"courseId": "course-1", "reason": "補發", "accessDays": 30},
            ),
            {
                "SELECT * FROM course_entitlements WHERE customer_id = ?1 AND course_id = ?2": [{
                    "id": "ent-1", "customer_id": CUSTOMER_ID, "course_id": "course-1",
                    "granted_at": 1_700_000_000, "access_days": 30,
                    "first_viewed_at": 1_700_000_100, "expires_at": 1_700_100_000,
                    "revoked_at": None, "revoke_reason": None,
                }],
            },
        )

        assert response.status == 201
        updates = [sql for sql, _ in call.database.writes if sql.startswith("UPDATE course_entitlements")]
        assert not any("expires_at" in sql for sql in updates)
        assert not any("access_days" in sql for sql in updates)


PAID_ORDER = {
    "id": ORDER_ID, "status": "paid", "subtotal": 1200, "shipping_fee": 0, "total": 1200,
    "shipping_method": "digital", "recipient_name": "", "recipient_phone": "",
    "recipient_email": "mei@example.com", "shipping_address": "", "store_name": None,
    "store_addr": None, "reserved_until": None, "paid_at": 1_700_000_000, "customer_id": CUSTOMER_ID,
    "created_at": 1_700_000_000,
}


class TestPaidButNotGranted:
    """They paid and the course is not there — the one failure a customer
    feels immediately and cannot work around.

    The repair re-runs provisioning rather than granting by hand, and that is
    the point: a hand-made grant has no fulfilment to name it by, so a later
    refund would not take it back.
    """

    def reconcile(self, call, answers=None):
        return call(
            admin_json("/api/orders/" + ORDER_ID + "/reconcile-entitlements", "POST", {}),
            answers,
        )

    def test_an_order_nobody_paid_for_is_refused(self, call):
        response = self.reconcile(
            call, {"SELECT * FROM orders WHERE id = ?1": [{**PAID_ORDER, "status": "pending", "paid_at": None}]}
        )

        assert response.status == 409

    def test_a_cancelled_order_is_refused(self, call):
        response = self.reconcile(
            call, {"SELECT * FROM orders WHERE id = ?1": [{**PAID_ORDER, "status": "cancelled"}]}
        )

        assert response.status == 409

    def test_a_shipped_mixed_order_can_still_be_repaired(self, call):
        """Its parcel went out; its course can still be the part that failed."""

        response = self.reconcile(
            call, {"SELECT * FROM orders WHERE id = ?1": [{**PAID_ORDER, "status": "shipped"}]}
        )

        assert response.status == 200

    def test_the_repair_produces_a_purchase_source_tied_to_the_fulfilment(self, call):
        self.reconcile(
            call,
            {
                "SELECT * FROM orders WHERE id = ?1": [PAID_ORDER],
                "SELECT * FROM order_fulfillments": [{
                    "id": "ff-1", "order_id": ORDER_ID, "order_item_id": "item-1",
                    "fulfillment_type": "course", "target_id": "course-1", "target_title": "水彩",
                    "sku": None, "quantity": 1, "access_days": 30, "status": "pending",
                }],
            },
        )

        sources = [
            bindings for sql, bindings in call.database.writes
            if "INSERT OR IGNORE INTO course_entitlement_sources" in sql
        ]
        # 'purchase', keyed on the fulfilment — which is what the refund path
        # looks it up by.
        assert sources and sources[0][2] == "ff-1"

    def test_it_leaves_a_trail_on_the_order(self, call):
        self.reconcile(call, {"SELECT * FROM orders WHERE id = ?1": [PAID_ORDER]})

        logged = [
            bindings for sql, bindings in call.database.writes
            if "INSERT INTO order_audit_log" in sql
        ]
        assert any(entry[2] == "entitlements_reconciled" for entry in logged)


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


GIFT_SOURCE = {
    "id": "s-gift",
    "entitlement_id": "ent-1",
    "source_kind": "gift",
    "source_order_fulfillment_id": None,
    "actor": "owner@example.com",
    "reason": "客訴補償",
    "revoked_at": None,
    "revoked_by": None,
    "revoke_reason": None,
}


class TestRevokingAGift:
    """A gift has no order to refund, so it needs a way back of its own.

    Without one, giving a course away was the only irreversible thing in the
    back office: the refund path revokes by fulfilment, and a gift has none.
    """

    def revoke(self, call, body, answers=None):
        return call(
            admin_json("/api/customers/" + CUSTOMER_ID + "/entitlements/revoke", "POST", body),
            answers,
        )

    def test_revoking_needs_a_reason(self, call):
        response = self.revoke(call, {"sourceId": "s-gift"})

        assert response.status == 400

    def test_a_gift_that_is_not_there_is_said_so_rather_than_shrugged_off(self, call):
        """Answering 200 to a revocation that revoked nothing would leave
        somebody believing they had taken access away."""

        response = self.revoke(call, {"sourceId": "s-gift", "reason": "誤送"})

        assert response.status == 409

    def test_revoking_the_only_reason_takes_the_access_too(self, call):
        response = self.revoke(
            call,
            {"sourceId": "s-gift", "reason": "誤送"},
            {"SELECT s.* FROM course_entitlement_sources": [GIFT_SOURCE]},
        )

        assert response.status == 200
        written = [sql for sql, _ in call.database.writes]
        assert any("UPDATE course_entitlement_sources" in sql for sql in written)
        assert any("UPDATE course_entitlements SET revoked_at" in sql for sql in written)

    def test_a_gift_still_paid_for_by_a_purchase_keeps_the_access(self, call):
        """Somebody gifted a course they had also bought still bought it."""

        response = self.revoke(
            call,
            {"sourceId": "s-gift", "reason": "誤送"},
            {
                "SELECT s.* FROM course_entitlement_sources": [GIFT_SOURCE],
                "SELECT COUNT(*) AS live FROM course_entitlement_sources": [{"live": 1}],
            },
        )

        assert response.status == 200
        written = [sql for sql, _ in call.database.writes]
        assert not any("UPDATE course_entitlements SET revoked_at" in sql for sql in written)

    def test_it_cannot_reach_a_purchase_or_somebody_elses_gift(self, call):
        """Read as an assertion about the statement because the guard *is* the
        statement: a purchase is taken back by recording the refund that
        justifies it, and reaching one from here would put a member's access
        and their money out of step."""

        self.revoke(call, {"sourceId": "s-gift", "reason": "誤送"})

        lookup = [
            (sql, bindings)
            for sql, bindings in call.database.reads
            if "FROM course_entitlement_sources s" in sql
        ]
        assert lookup, "the revoke never looked the source up"
        sql, bindings = lookup[0]
        assert "s.source_kind IN ('gift', 'manual')" in sql
        assert "e.customer_id = ?2" in sql
        assert bindings[1] == CUSTOMER_ID


REVOKED_SOURCE = {**GIFT_SOURCE, "revoked_at": 1_700_000_500, "revoked_by": "owner@example.com", "revoke_reason": "誤送"}


class TestRestoring:
    """Undoing a revocation that should not have happened.

    Everything a revocation touches is a flag, so putting it back is possible
    at all. What it must not put back is time.
    """

    def restore(self, call, body, answers=None):
        return call(
            admin_json("/api/customers/" + CUSTOMER_ID + "/entitlements/restore", "POST", body),
            answers,
        )

    def test_restoring_needs_a_reason(self, call):
        response = self.restore(call, {"sourceId": "s-gift"})

        assert response.status == 400

    def test_a_source_that_was_never_revoked_is_refused(self, call):
        """Answering 200 would tell somebody they had undone something."""

        response = self.restore(call, {"sourceId": "s-gift", "reason": "誤撤銷"})

        assert response.status == 409

    def test_it_clears_the_revocation_from_the_source_and_the_access(self, call):
        response = self.restore(
            call,
            {"sourceId": "s-gift", "reason": "誤撤銷"},
            {"SELECT s.* FROM course_entitlement_sources": [REVOKED_SOURCE]},
        )

        assert response.status == 200
        written = [sql for sql, _ in call.database.writes]
        assert any("SET revoked_at = NULL, revoked_by = NULL" in sql for sql in written)
        assert any("UPDATE course_entitlements SET revoked_at = NULL" in sql for sql in written)

    def test_it_does_not_hand_back_the_days_that_went_by(self, call):
        """Otherwise "revoke, then restore" is a way of extending somebody's
        window that nothing in the shop would ever show up as."""

        self.restore(
            call,
            {"sourceId": "s-gift", "reason": "誤撤銷"},
            {"SELECT s.* FROM course_entitlement_sources": [REVOKED_SOURCE]},
        )

        # Only the updates: the migrations run on every request here, and the
        # table they create names both columns.
        updates = [sql for sql, _ in call.database.writes if sql.startswith("UPDATE")]
        assert updates, "the restore wrote nothing"
        assert not any("expires_at" in sql for sql in updates)
        assert not any("first_viewed_at" in sql for sql in updates)

    def test_a_purchase_can_be_put_back_even_though_it_cannot_be_taken_away_here(self, call):
        """A wrongly recorded refund is the case this exists for. Refusing it
        would leave that as the one thing nobody could put right."""

        response = self.restore(
            call,
            {"sourceId": "s-buy", "reason": "退款記錯訂單"},
            {
                "SELECT s.* FROM course_entitlement_sources": [
                    {**REVOKED_SOURCE, "id": "s-buy", "source_kind": "purchase"}
                ]
            },
        )

        assert response.status == 200

    def test_it_cannot_reach_another_members_grant(self, call):
        self.restore(call, {"sourceId": "s-gift", "reason": "誤撤銷"})

        lookup = [
            (sql, bindings)
            for sql, bindings in call.database.reads
            if "FROM course_entitlement_sources s" in sql
        ]
        assert lookup, "the restore never looked the source up"
        sql, bindings = lookup[0]
        assert "e.customer_id = ?2" in sql
        assert "s.revoked_at IS NOT NULL" in sql
        assert bindings[1] == CUSTOMER_ID


class TestTheRecord:
    """What was done to somebody's access, kept where restoring cannot erase it.

    The source row holds what is true now. Restoring clears the revocation off
    it, so the decisions have to live somewhere a second revocation would not
    overwrite and a restore would not wipe.
    """

    def test_a_gift_is_written_down(self, call):
        call(
            admin_json(
                "/api/customers/" + CUSTOMER_ID + "/entitlements/gift",
                "POST",
                {"courseId": "course-1", "reason": "客訴補償"},
            ),
        )

        logged = [
            bindings for sql, bindings in call.database.writes
            if "INSERT INTO course_entitlement_audit_log" in sql
        ]
        assert logged and logged[0][3] == "gift"
        assert logged[0][2] == "owner@example.com"
        assert logged[0][4] == "客訴補償"

    def test_a_revocation_and_the_restore_after_it_are_both_kept(self, call):
        call(
            admin_json("/api/customers/" + CUSTOMER_ID + "/entitlements/revoke", "POST",
                       {"sourceId": "s-gift", "reason": "誤送"}),
            {"SELECT s.* FROM course_entitlement_sources": [GIFT_SOURCE]},
        )
        revoked = [b for sql, b in call.database.writes if "INSERT INTO course_entitlement_audit_log" in sql]

        call(
            admin_json("/api/customers/" + CUSTOMER_ID + "/entitlements/restore", "POST",
                       {"sourceId": "s-gift", "reason": "誤撤銷"}),
            {"SELECT s.* FROM course_entitlement_sources": [REVOKED_SOURCE]},
        )
        restored = [b for sql, b in call.database.writes if "INSERT INTO course_entitlement_audit_log" in sql]

        assert revoked[0][3] == "revoke"
        assert restored[0][3] == "restore"
        assert restored[0][4] == "誤撤銷"

    def test_a_paid_order_writes_nothing_here(self, call):
        """A grant that followed a payment is the system doing its job, and is
        already in the order's own log. A line per sale would bury the handful
        of entries anybody is ever looking for."""

        import asyncio as _asyncio

        from conftest import FakeDatabase, make_env
        from domain import entitlements

        env = make_env(FakeDatabase({}))
        _asyncio.run(
            entitlements.grant_from_fulfillment(
                env, customer_id=CUSTOMER_ID, course_id="course-1",
                fulfillment_id="ff-1", access_days=None,
            )
        )

        assert not [sql for sql, _ in env.DB.writes if "course_entitlement_audit_log" in sql]


class TestSeeingWhatSomebodyHas:
    def test_a_members_access_can_be_listed(self, call):
        response = call(admin_get("/api/customers/" + CUSTOMER_ID + "/entitlements"))

        assert response.status == 200
        assert response.json()["entitlements"] == []

    def test_it_says_which_course_and_not_only_which_id(self, call):
        """The screen this feeds is where somebody decides to take access
        away. Deciding that from a row of opaque ids is how the wrong course
        gets revoked."""

        response = call(
            admin_get("/api/customers/" + CUSTOMER_ID + "/entitlements"),
            {
                "SELECT * FROM course_entitlements WHERE customer_id": [{
                    "id": "ent-1", "customer_id": CUSTOMER_ID, "course_id": "course-1",
                    "granted_at": 1_700_000_000, "access_days": None, "first_viewed_at": None,
                    "expires_at": None, "revoked_at": None, "revoke_reason": None,
                }],
                "SELECT id, title FROM courses": [{"id": "course-1", "title": "水彩花卉入門"}],
                "SELECT * FROM course_entitlement_sources": [GIFT_SOURCE],
            },
        )

        listed = response.json()["entitlements"][0]
        assert listed["courseTitle"] == "水彩花卉入門"
        assert listed["active"] is True
        assert listed["sources"][0]["kind"] == "gift"

    def test_a_course_that_was_revoked_and_put_back_still_shows_it_happened(self, call):
        """The source row says nothing about it — restoring clears the
        revocation off it — so the page would otherwise look as though the
        course had sat there untouched the whole time."""

        response = call(
            admin_get("/api/customers/" + CUSTOMER_ID + "/entitlements"),
            {
                "SELECT * FROM course_entitlements WHERE customer_id": [{
                    "id": "ent-1", "customer_id": CUSTOMER_ID, "course_id": "course-1",
                    "granted_at": 1_700_000_000, "access_days": None, "first_viewed_at": None,
                    "expires_at": None, "revoked_at": None, "revoke_reason": None,
                }],
                "SELECT id, title FROM courses": [{"id": "course-1", "title": "水彩花卉入門"}],
                "SELECT * FROM course_entitlement_sources": [GIFT_SOURCE],
                "SELECT * FROM course_entitlement_audit_log": [
                    {"entitlement_id": "ent-1", "source_id": "s-gift", "actor": "owner@example.com",
                     "action": "restore", "reason": "誤撤銷", "created_at": 1_700_000_900},
                    {"entitlement_id": "ent-1", "source_id": "s-gift", "actor": "owner@example.com",
                     "action": "revoke", "reason": "誤送", "created_at": 1_700_000_500},
                ],
            },
        )

        assert [entry["action"] for entry in response.json()["entitlements"][0]["history"]] == [
            "restore",
            "revoke",
        ]

    def test_none_of_it_is_open_without_a_session(self, call):
        anonymous = FakeRequest(
            "/api/customers/" + CUSTOMER_ID + "/entitlements", "GET",
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST,
        )

        assert call(anonymous).status == 401
