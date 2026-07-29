"""What a member is owed once they have paid, and why.

Two things decide the shape here. A payment callback can arrive more than
once, so granting has to be safe to repeat. And a member who bought the same
course twice has one grant with two reasons behind it, so a refund of one
purchase must not take away access the other still pays for.

The viewing clock is deliberately not started here. `access_days` is copied
from the fulfilment and `expires_at` stays null until the member actually
watches something — phase 6 writes it. Starting it at payment would spend a
member's window while they were waiting for the material kit to arrive.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def entitlements():
    from domain import entitlements as module

    return module


class TestActiveEntitlement:
    def test_a_permanent_grant_is_active(self, entitlements):
        assert entitlements.is_active({"revokedAt": None, "expiresAt": None}, now=1000) is True

    def test_a_revoked_grant_is_not(self, entitlements):
        assert entitlements.is_active({"revokedAt": 5, "expiresAt": None}, now=1000) is False

    def test_a_grant_whose_window_has_closed_is_not(self, entitlements):
        assert entitlements.is_active({"revokedAt": None, "expiresAt": 999}, now=1000) is False

    def test_a_grant_still_inside_its_window_is(self, entitlements):
        assert entitlements.is_active({"revokedAt": None, "expiresAt": 1001}, now=1000) is True

    def test_a_timed_grant_nobody_has_watched_yet_is_active(self, entitlements):
        """`expiresAt` is null until the first playback. That is not the same
        as permanent, and it is certainly not expired."""

        assert entitlements.is_active({"revokedAt": None, "expiresAt": None, "accessDays": 30}, now=1000) is True


class TestGranting:
    def _database(self, existing: list[dict] | None = None) -> FakeDatabase:
        return FakeDatabase({"SELECT * FROM course_entitlements": existing or []})

    def test_a_first_purchase_creates_the_grant_and_records_why(self, entitlements):
        database = self._database()

        asyncio.run(
            entitlements.grant_from_fulfillment(
                make_env(database),
                customer_id="cust-1",
                course_id="course-1",
                fulfillment_id="ff-1",
                access_days=30,
            )
        )

        statements = [statement for statement, _ in database.writes]
        assert any("INSERT INTO course_entitlements" in statement for statement in statements)
        assert any(
            "INSERT OR IGNORE INTO course_entitlement_sources" in statement for statement in statements
        )

    def test_the_clock_is_not_started_at_payment(self, entitlements):
        """A member waiting on a material kit must not be spending their
        window before they can watch anything."""

        database = self._database()

        asyncio.run(
            entitlements.grant_from_fulfillment(
                make_env(database),
                customer_id="cust-1",
                course_id="course-1",
                fulfillment_id="ff-1",
                access_days=30,
            )
        )

        insert, bindings = next(w for w in database.writes if "INSERT INTO course_entitlements" in w[0])
        assert "first_viewed_at" in insert
        # access_days is stored; both timestamps stay null for phase 6.
        assert 30 in bindings
        assert insert.count("NULL") >= 2

    def test_a_second_purchase_of_a_held_course_adds_a_reason_not_a_grant(self, entitlements):
        database = self._database(
            [{
                "id": "ent-1", "customer_id": "cust-1", "course_id": "course-1", "granted_at": 0,
                "access_days": None, "first_viewed_at": None, "expires_at": None,
                "revoked_at": None, "revoke_reason": None, "created_at": 0, "updated_at": 0,
            }]
        )

        asyncio.run(
            entitlements.grant_from_fulfillment(
                make_env(database),
                customer_id="cust-1",
                course_id="course-1",
                fulfillment_id="ff-2",
                access_days=None,
            )
        )

        statements = [statement for statement, _ in database.writes]
        assert not any("INSERT INTO course_entitlements" in statement for statement in statements)
        assert any("INSERT OR IGNORE INTO course_entitlement_sources" in statement for statement in statements)

    def test_granting_again_from_the_same_payment_does_not_extend_anything(self, entitlements):
        """A resent callback runs the same statements. None of them may touch
        `expires_at`, or a member's window would grow every retry."""

        database = self._database(
            [{
                "id": "ent-1", "customer_id": "cust-1", "course_id": "course-1", "granted_at": 0,
                "access_days": 30, "first_viewed_at": 500, "expires_at": 3_092_000,
                "revoked_at": None, "revoke_reason": None, "created_at": 0, "updated_at": 0,
            }]
        )

        asyncio.run(
            entitlements.grant_from_fulfillment(
                make_env(database),
                customer_id="cust-1",
                course_id="course-1",
                fulfillment_id="ff-1",
                access_days=30,
            )
        )

        assert not any("expires_at" in statement for statement, _ in database.writes)

    def test_a_revoked_grant_is_reinstated_by_buying_again(self, entitlements):
        """Refunding and repurchasing has to give access back. Leaving the
        revocation in place would take the member's money and nothing else."""

        database = self._database(
            [{
                "id": "ent-1", "customer_id": "cust-1", "course_id": "course-1", "granted_at": 0,
                "access_days": None, "first_viewed_at": None, "expires_at": None,
                "revoked_at": 900, "revoke_reason": "refund", "created_at": 0, "updated_at": 0,
            }]
        )

        asyncio.run(
            entitlements.grant_from_fulfillment(
                make_env(database),
                customer_id="cust-1",
                course_id="course-1",
                fulfillment_id="ff-2",
                access_days=None,
            )
        )

        reinstate = next(w for w in database.writes if "UPDATE course_entitlements" in w[0])
        assert "revoked_at = NULL" in reinstate[0]


class TestRevoking:
    def test_revoking_one_purchase_leaves_access_another_still_pays_for(self, entitlements):
        database = FakeDatabase(
            {
                "SELECT * FROM course_entitlement_sources": [
                    {"id": "s1", "entitlement_id": "ent-1", "source_kind": "purchase",
                     "source_order_fulfillment_id": "ff-1", "revoked_at": None},
                ],
                # One source survives, so the grant itself stands.
                "SELECT COUNT(*) AS live FROM course_entitlement_sources": [{"live": 1}],
            }
        )

        asyncio.run(
            entitlements.revoke_source(
                make_env(database), fulfillment_id="ff-1", actor="owner@example.com", reason="refund"
            )
        )

        statements = [statement for statement, _ in database.writes]
        assert any("UPDATE course_entitlement_sources" in statement for statement in statements)
        assert not any("UPDATE course_entitlements SET revoked_at" in statement for statement in statements)

    def test_revoking_the_last_purchase_takes_the_access_away(self, entitlements):
        database = FakeDatabase(
            {
                "SELECT * FROM course_entitlement_sources": [
                    {"id": "s1", "entitlement_id": "ent-1", "source_kind": "purchase",
                     "source_order_fulfillment_id": "ff-1", "revoked_at": None},
                ],
                "SELECT COUNT(*) AS live FROM course_entitlement_sources": [{"live": 0}],
            }
        )

        asyncio.run(
            entitlements.revoke_source(
                make_env(database), fulfillment_id="ff-1", actor="owner@example.com", reason="refund"
            )
        )

        assert any("UPDATE course_entitlements SET revoked_at" in w[0] for w in database.writes)

    def test_revoking_something_already_revoked_changes_nothing(self, entitlements):
        database = FakeDatabase({"SELECT * FROM course_entitlement_sources": []})

        asyncio.run(
            entitlements.revoke_source(
                make_env(database), fulfillment_id="ff-9", actor="owner@example.com", reason="refund"
            )
        )

        assert database.writes == []


class TestPurchaseLocks:
    """Stopping a member paying twice for one grant.

    The cart can say "you already own this", but the cart is a page, not a
    guarantee: two tabs, or two taps on a slow connection, both pass that
    check before either order exists. The lock is what makes the second one
    lose.
    """

    def test_a_first_checkout_takes_the_lock(self, entitlements):
        database = FakeDatabase(changes={"INSERT OR IGNORE INTO course_offer_purchase_locks": 1})

        assert asyncio.run(
            entitlements.hold_offer(make_env(database), customer_id="c1", offer_id="off-1", order_id="LS1", expires_at=900)
        ) is True

    def test_a_second_checkout_for_the_same_offer_does_not(self, entitlements):
        """INSERT OR IGNORE, so whoever loses the race is told, not crashed."""

        # The insert loses, and the hold it lost to has not run out, so the
        # takeover matches nothing either.
        database = FakeDatabase(
            changes={
                "INSERT OR IGNORE INTO course_offer_purchase_locks": 0,
                "UPDATE course_offer_purchase_locks": 0,
            }
        )

        assert asyncio.run(
            entitlements.hold_offer(make_env(database), customer_id="c1", offer_id="off-1", order_id="LS2", expires_at=900)
        ) is False

    def test_an_expired_hold_is_taken_over_rather_than_blocking_forever(self, entitlements):
        """A cart abandoned at the payment page must not lock the member out
        of ever buying that course."""

        database = FakeDatabase(changes={"INSERT OR IGNORE INTO course_offer_purchase_locks": 0, "UPDATE course_offer_purchase_locks": 1})

        assert asyncio.run(
            entitlements.hold_offer(make_env(database), customer_id="c1", offer_id="off-1", order_id="LS2", expires_at=900)
        ) is True

        takeover = next(w for w in database.writes if "UPDATE course_offer_purchase_locks" in w[0])
        assert "state = 'pending'" in takeover[0]
        assert "expires_at <" in takeover[0]

    def test_paying_keeps_the_hold_but_stops_it_expiring(self, entitlements):
        """A paid grant is not a transient hold. It stays until the access it
        produced is gone, or the member could buy the same course twice."""

        database = FakeDatabase()

        asyncio.run(entitlements.confirm_hold(make_env(database), order_id="LS1"))

        statement, _ = database.writes[0]
        assert "state = 'paid'" in statement
        assert "expires_at = NULL" in statement

    def test_an_order_that_never_paid_releases_its_hold(self, entitlements):
        database = FakeDatabase()

        asyncio.run(entitlements.release_holds(make_env(database), order_id="LS1"))

        statement, bindings = database.writes[0]
        assert "DELETE FROM course_offer_purchase_locks" in statement
        assert bindings == ("LS1",)


class TestStartingTheViewingWindow:
    """The clock starts at the first watch, and only at the first."""

    def test_a_timed_grant_starts_counting(self, entitlements):
        database = FakeDatabase(changes={"UPDATE course_entitlements SET first_viewed_at": 1})

        started = asyncio.run(
            entitlements.start_viewing_window(
                make_env(database), entitlement_id="ent-1", access_days=30, now=1000
            )
        )

        assert started is True
        statement, bindings = database.writes[0]
        # The condition is what makes this happen once. Two playback requests
        # arriving together would otherwise both write, and the later one
        # would quietly extend the member's window.
        assert "first_viewed_at IS NULL" in statement
        assert 1000 + 30 * 86400 in bindings

    def test_a_permanent_grant_writes_nothing(self, entitlements):
        database = FakeDatabase()

        assert asyncio.run(
            entitlements.start_viewing_window(
                make_env(database), entitlement_id="ent-1", access_days=None, now=1000
            )
        ) is False
        assert database.writes == []

    def test_a_second_playback_changes_nothing(self, entitlements):
        """The row no longer matches, so the update affects nothing — which is
        the answer, not an error."""

        database = FakeDatabase(changes={"UPDATE course_entitlements SET first_viewed_at": 0})

        assert asyncio.run(
            entitlements.start_viewing_window(
                make_env(database), entitlement_id="ent-1", access_days=30, now=9999
            )
        ) is False

    def test_a_revoked_grant_does_not_start_counting(self, entitlements):
        """Nothing should be able to watch it, so nothing should start it."""

        database = FakeDatabase(changes={"UPDATE course_entitlements SET first_viewed_at": 1})

        asyncio.run(
            entitlements.start_viewing_window(
                make_env(database), entitlement_id="ent-1", access_days=30, now=1000
            )
        )

        statement, _ = database.writes[0]
        assert "revoked_at IS NULL" in statement
