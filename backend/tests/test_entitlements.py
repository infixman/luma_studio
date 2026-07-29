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
