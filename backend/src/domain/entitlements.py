"""What a member is owed once they have paid, and why.

A member holds one entitlement per course, and any number of *reasons* for
holding it: two purchases of the same bundle, or a purchase and a gift. That
split is what makes refunds behave. Revoking a purchase removes its reason; it
only removes the access itself when no reason is left.

Everything here is safe to repeat. A payment callback can arrive twice, and a
reconciliation job will run the same grant again on purpose, so the grant is
an upsert and the reason is an INSERT OR IGNORE keyed on the fulfilment that
caused it.

One thing this module deliberately does *not* do is start the viewing clock.
`access_days` is copied from the fulfilment and `expires_at` stays null until
the member first watches something, which phase 6 writes. Starting it at
payment would spend a member's window while they were still waiting for the
material kit to arrive.
"""

from shared.common import d1_changed, d1_rows, urlsafe_token, utc_timestamp


def is_active(entitlement: dict, *, now: int) -> bool:
    """Whether this grant currently lets someone watch.

    A null `expiresAt` means one of two things — permanent, or timed but not
    yet started — and both are active. Distinguishing them matters for what
    the member is shown, not for whether they may watch.
    """

    if entitlement["revokedAt"] is not None:
        return False
    expires_at = entitlement["expiresAt"]
    return expires_at is None or expires_at > now


def entitlement_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "customerId": row["customer_id"],
        "courseId": row["course_id"],
        "grantedAt": int(row["granted_at"]),
        "accessDays": None if row["access_days"] is None else int(row["access_days"]),
        "firstViewedAt": None if row["first_viewed_at"] is None else int(row["first_viewed_at"]),
        "expiresAt": None if row["expires_at"] is None else int(row["expires_at"]),
        "revokedAt": None if row["revoked_at"] is None else int(row["revoked_at"]),
        "revokeReason": row["revoke_reason"],
    }


async def get_entitlement(env, customer_id: str, course_id: str) -> dict | None:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM course_entitlements WHERE customer_id = ?1 AND course_id = ?2"
        ).bind(customer_id, course_id)
    )
    return entitlement_row(rows[0]) if rows else None


async def active_course_ids(env, customer_id: str) -> set[str]:
    """Which courses this member may watch right now."""

    now = utc_timestamp()
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM course_entitlements WHERE customer_id = ?1 AND revoked_at IS NULL"
        ).bind(customer_id)
    )
    return {row["course_id"] for row in rows if is_active(entitlement_row(row), now=now)}


async def grant_from_fulfillment(
    env, *, customer_id: str, course_id: str, fulfillment_id: str, access_days: int | None
) -> str:
    """Give a member a course because an order said so. Safe to repeat.

    Returns the entitlement id either way, so the caller can mark the
    fulfilment done without needing to know whether this was the first time.
    """

    now = utc_timestamp()
    existing = await get_entitlement(env, customer_id, course_id)

    if existing is None:
        entitlement_id = urlsafe_token(18)
        await env.DB.prepare(
            "INSERT INTO course_entitlements"
            " (id, customer_id, course_id, granted_at, access_days, first_viewed_at, expires_at,"
            "  revoked_at, revoke_reason, created_at, updated_at)"
            " VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?4, ?4)"
        ).bind(entitlement_id, customer_id, course_id, now, access_days).run()
    else:
        entitlement_id = existing["id"]
        if existing["revokedAt"] is not None:
            # Buying again after a refund has to give access back. Leaving the
            # revocation would take the member's money and nothing else.
            #
            # `expires_at` is untouched on purpose: a resent callback runs
            # this same path, and a window that grew on every retry would be
            # a bug nobody would notice until it mattered.
            await env.DB.prepare(
                "UPDATE course_entitlements"
                " SET revoked_at = NULL, revoke_reason = NULL, updated_at = ?2"
                " WHERE id = ?1"
            ).bind(entitlement_id, now).run()

    await env.DB.prepare(
        "INSERT OR IGNORE INTO course_entitlement_sources"
        " (id, entitlement_id, source_kind, source_order_fulfillment_id, actor, reason, created_at)"
        " VALUES (?1, ?2, 'purchase', ?3, NULL, NULL, ?4)"
    ).bind(urlsafe_token(18), entitlement_id, fulfillment_id, now).run()

    return entitlement_id


async def grant_as_gift(env, *, customer_id: str, course_id: str, actor: str, reason: str) -> str:
    """Give a course away without inventing an order for it.

    A zero-value order line would put something in the sales figures that was
    never sold. The reason is required: a grant nobody can account for is one
    nobody can undo with confidence either.
    """

    if not actor or not reason:
        raise ValueError("贈送課程必須記錄操作人與原因")

    now = utc_timestamp()
    existing = await get_entitlement(env, customer_id, course_id)
    if existing is None:
        entitlement_id = urlsafe_token(18)
        await env.DB.prepare(
            "INSERT INTO course_entitlements"
            " (id, customer_id, course_id, granted_at, access_days, first_viewed_at, expires_at,"
            "  revoked_at, revoke_reason, created_at, updated_at)"
            " VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, NULL, ?4, ?4)"
        ).bind(entitlement_id, customer_id, course_id, now).run()
    else:
        entitlement_id = existing["id"]
        if existing["revokedAt"] is not None:
            await env.DB.prepare(
                "UPDATE course_entitlements"
                " SET revoked_at = NULL, revoke_reason = NULL, updated_at = ?2 WHERE id = ?1"
            ).bind(entitlement_id, now).run()

    await env.DB.prepare(
        "INSERT INTO course_entitlement_sources"
        " (id, entitlement_id, source_kind, source_order_fulfillment_id, actor, reason, created_at)"
        " VALUES (?1, ?2, 'gift', NULL, ?3, ?4, ?5)"
    ).bind(urlsafe_token(18), entitlement_id, actor, reason, now).run()

    return entitlement_id


async def _live_source_count(env, entitlement_id: str, *, excluding: str) -> int:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT COUNT(*) AS live FROM course_entitlement_sources"
            " WHERE entitlement_id = ?1 AND revoked_at IS NULL AND id != ?2"
        ).bind(entitlement_id, excluding)
    )
    return int(rows[0]["live"]) if rows else 0


async def revoke_source(env, *, fulfillment_id: str, actor: str, reason: str) -> bool:
    """Take back one reason a member has access.

    The access itself only goes when nothing else is paying for it. Somebody
    who bought the same bundle twice and refunded one of them still bought it
    once, and taking the course away would be wrong in a way they would
    notice immediately.

    Nothing is deleted. Progress, orders and the audit trail all stay, so
    reinstating is a matter of undoing one flag.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM course_entitlement_sources"
            " WHERE source_kind = 'purchase' AND source_order_fulfillment_id = ?1 AND revoked_at IS NULL"
        ).bind(fulfillment_id)
    )
    if not rows:
        # Already revoked, or never granted. Both mean there is nothing to do,
        # which is what makes this safe to run from a retried refund.
        return False

    source = rows[0]
    now = utc_timestamp()
    await env.DB.prepare(
        "UPDATE course_entitlement_sources"
        " SET revoked_at = ?2, revoked_by = ?3, revoke_reason = ?4 WHERE id = ?1"
    ).bind(source["id"], now, actor, reason).run()

    if await _live_source_count(env, source["entitlement_id"], excluding=source["id"]) == 0:
        await env.DB.prepare(
            "UPDATE course_entitlements SET revoked_at = ?2, revoke_reason = ?3, updated_at = ?2"
            " WHERE id = ?1 AND revoked_at IS NULL"
        ).bind(source["entitlement_id"], now, reason).run()

    return True


async def hold_offer(env, *, customer_id: str, offer_id: str, order_id: str, expires_at: int) -> bool:
    """Claim the right to be the one order buying this offer for this member.

    The cart already says "you already own this", but a page is not a
    guarantee: two tabs, or two taps on a slow connection, both pass that
    check before either order exists. This is what makes the second lose.

    An expired hold is taken over rather than blocking forever — a cart
    abandoned at the payment page must not lock somebody out of ever buying
    that course.
    """

    now = utc_timestamp()
    result = await env.DB.prepare(
        "INSERT OR IGNORE INTO course_offer_purchase_locks"
        " (customer_id, offer_id, order_id, state, expires_at, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5)"
    ).bind(customer_id, offer_id, order_id, expires_at, now).run()
    if d1_changed(result):
        return True

    # Somebody holds it. Only a *pending* hold that has run out is up for
    # grabs; a paid one stands until the access it produced is gone.
    takeover = await env.DB.prepare(
        "UPDATE course_offer_purchase_locks"
        " SET order_id = ?3, state = 'pending', expires_at = ?4, updated_at = ?5"
        " WHERE customer_id = ?1 AND offer_id = ?2 AND state = 'pending' AND expires_at IS NOT NULL"
        " AND expires_at < ?5"
    ).bind(customer_id, offer_id, order_id, expires_at, now).run()
    return d1_changed(takeover)


async def confirm_hold(env, *, order_id: str) -> None:
    """Payment landed, so the hold stops being transient.

    Clearing `expires_at` matters: a paid grant that expired like an abandoned
    cart would let the member buy the same course again a quarter of an hour
    later.
    """

    await env.DB.prepare(
        "UPDATE course_offer_purchase_locks SET state = 'paid', expires_at = NULL, updated_at = ?2"
        " WHERE order_id = ?1"
    ).bind(order_id, utc_timestamp()).run()


async def release_holds(env, *, order_id: str) -> None:
    """The order will never pay, so nothing is being bought twice."""

    await env.DB.prepare("DELETE FROM course_offer_purchase_locks WHERE order_id = ?1").bind(order_id).run()


async def start_viewing_window(env, *, entitlement_id: str, access_days: int | None, now: int) -> bool:
    """Begin a timed grant's countdown, once.

    Called on every playback, which is why the condition matters more than the
    call does: `first_viewed_at IS NULL` means two requests arriving together
    produce one write, and every request after the first produces none. Without
    it, the window would quietly restart each time somebody pressed play, and a
    thirty-day course would be permanent.

    A permanent grant has no clock and writes nothing. A revoked one should not
    be watchable at all, so it does not start either.
    """

    if access_days is None:
        return False

    result = await env.DB.prepare(
        "UPDATE course_entitlements SET first_viewed_at = ?2, expires_at = ?3, updated_at = ?2"
        " WHERE id = ?1 AND access_days IS NOT NULL AND first_viewed_at IS NULL AND revoked_at IS NULL"
    ).bind(entitlement_id, now, now + access_days * 86400).run()
    return d1_changed(result)
