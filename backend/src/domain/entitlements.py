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


# A grant a person made, as opposed to one a payment made. Both are sources;
# the difference is what they mean and what can take them back.
BY_HAND_KINDS = ("gift", "manual")


async def _grant_by_hand(
    env,
    *,
    customer_id: str,
    course_id: str,
    actor: str,
    reason: str,
    kind: str,
    access_days: int | None,
) -> str:
    """Give somebody a course without an order having said so.

    A zero-value order line would put something in the sales figures that was
    never sold, so neither of these invents one. The reason is required: a
    grant nobody can account for is one nobody can undo with confidence.

    `access_days` applies only when the entitlement is being created. A member
    who already holds the course keeps the window they already had — running
    this twice, or re-issuing a course somebody is part way through, must not
    hand them more time than they bought. Extending is a separate decision.
    """

    if not actor or not reason:
        raise ValueError("授與課程必須記錄操作人與原因")
    if kind not in BY_HAND_KINDS:
        raise ValueError(f"Unknown grant kind: {kind}")

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
            await env.DB.prepare(
                "UPDATE course_entitlements"
                " SET revoked_at = NULL, revoke_reason = NULL, updated_at = ?2 WHERE id = ?1"
            ).bind(entitlement_id, now).run()

    source_id = urlsafe_token(18)
    await env.DB.prepare(
        "INSERT INTO course_entitlement_sources"
        " (id, entitlement_id, source_kind, source_order_fulfillment_id, actor, reason, created_at)"
        " VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)"
    ).bind(source_id, entitlement_id, kind, actor, reason, now).run()

    await audit(
        env,
        entitlement_id=entitlement_id,
        source_id=source_id,
        actor=actor,
        action=kind,
        reason=reason,
    )
    return entitlement_id


async def grant_as_gift(env, *, customer_id: str, course_id: str, actor: str, reason: str) -> str:
    """Give a course away. Permanent, because a gift with a countdown on it is
    a strange thing to give somebody."""

    return await _grant_by_hand(
        env,
        customer_id=customer_id,
        course_id=course_id,
        actor=actor,
        reason=reason,
        kind="gift",
        access_days=None,
    )


async def grant_manually(
    env, *, customer_id: str, course_id: str, actor: str, reason: str, access_days: int | None = None
) -> str:
    """Hand over a course the member should already have had.

    Kept apart from a gift because they are different claims about what
    happened. A gift is the shop choosing to give something away; this is the
    shop failing to deliver something and putting it right, and the accounts
    read differently for each.

    Carries `access_days` for the same reason: re-issuing a thirty-day course
    as a permanent one would quietly upgrade what the member bought.

    **This is not the repair for a paid order that never granted.** Use
    `orders.provision_paid_order`, which produces a `purchase` source tied to
    the fulfilment. A `manual` source has no fulfilment to name it by, so a
    refund of that order would not take it back — the member would get their
    money returned and keep the course.
    """

    return await _grant_by_hand(
        env,
        customer_id=customer_id,
        course_id=course_id,
        actor=actor,
        reason=reason,
        kind="manual",
        access_days=access_days,
    )


async def audit(
    env, *, entitlement_id: str, source_id: str | None, actor: str, action: str, reason: str
) -> None:
    """Record a decision a person made about somebody's access.

    Only decisions. A grant that followed a paid order is the system doing its
    job and is already in the order's own log; writing a line here per sale
    would bury the handful of entries anybody is ever looking for.
    """

    await env.DB.prepare(
        "INSERT INTO course_entitlement_audit_log"
        " (entitlement_id, source_id, actor, action, reason, created_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(entitlement_id, source_id, actor, action, reason, utc_timestamp()).run()


async def history(env, entitlement_ids: list[str]) -> dict[str, list[dict]]:
    """Every decision behind these grants, newest first.

    The cap is a runaway guard, not a page size. Callers ask about at most the
    200 entitlements `list_for_customer` returns, and a course somebody has
    gifted, revoked and restored still only carries three rows — so 1000 is
    five deliberate acts on every course a member owns.
    """

    if not entitlement_ids:
        return {}
    placeholders = ", ".join(f"?{index + 1}" for index in range(len(entitlement_ids)))
    rows = await d1_rows(
        env.DB.prepare(
            f"SELECT * FROM course_entitlement_audit_log WHERE entitlement_id IN ({placeholders})"
            " ORDER BY created_at DESC, id DESC LIMIT 1000"
        ).bind(*entitlement_ids)
    )
    by_entitlement: dict[str, list[dict]] = {}
    for row in rows:
        by_entitlement.setdefault(row["entitlement_id"], []).append(
            {
                "sourceId": row["source_id"],
                "actor": row["actor"],
                "action": row["action"],
                "reason": row["reason"],
                "createdAt": int(row["created_at"]),
            }
        )
    return by_entitlement


async def _live_source_count(env, entitlement_id: str, *, excluding: str) -> int:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT COUNT(*) AS live FROM course_entitlement_sources"
            " WHERE entitlement_id = ?1 AND revoked_at IS NULL AND id != ?2"
        ).bind(entitlement_id, excluding)
    )
    return int(rows[0]["live"]) if rows else 0


async def _revoke_row(env, source: dict, *, actor: str, reason: str) -> None:
    """Strike one source, and the access with it if it was the last one.

    Nothing is deleted. Progress, orders and the log all stay, which is what
    makes `restore_source` possible.
    """

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

    await audit(
        env,
        entitlement_id=source["entitlement_id"],
        source_id=source["id"],
        actor=actor,
        action="revoke",
        reason=reason,
    )


async def restore_source(env, *, customer_id: str, source_id: str, actor: str, reason: str) -> bool:
    """Put back a revocation.

    Per source, like revoking, and for the same reason: a member with two
    reasons for a course had one of them taken away, and giving back "the
    access" rather than that reason would lose which one was wrong.

    Any kind of source, unlike revoking. Taking a purchase back has to go
    through the refund that justifies it because money is involved; giving one
    back is undoing a mistake, and refusing to would leave a wrongly-recorded
    refund as the one thing in this back office nobody could put right.

    What it deliberately does not touch is `first_viewed_at` and `expires_at`.
    A timed grant's clock ran while the access was gone, and handing those days
    back here would quietly turn "revoke, then restore" into a way of extending
    somebody's window that nothing would ever show up as. Extending is a
    different decision and has to be a different operation.

    So a restored grant is not always a watchable one: put back a thirty-day
    course two months after it was revoked and the member still sees nothing.
    That is the honest answer, and the caller is told the expiry so it can say
    so before anybody clicks.
    """

    if not reason:
        raise ValueError("恢復觀看權必須填寫原因")

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT s.* FROM course_entitlement_sources s"
            " JOIN course_entitlements e ON e.id = s.entitlement_id"
            " WHERE s.id = ?1 AND e.customer_id = ?2 AND s.revoked_at IS NOT NULL"
        ).bind(source_id, customer_id)
    )
    if not rows:
        return False

    source = rows[0]
    now = utc_timestamp()
    # Cleared rather than kept beside a `restored_at`: `revoked_at IS NULL`
    # means live everywhere in this module, and a second meaning for it would
    # have to be remembered in every query that asks. What was cleared is in
    # the log.
    await env.DB.prepare(
        "UPDATE course_entitlement_sources"
        " SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE id = ?1"
    ).bind(source["id"]).run()

    # This source is live again, so the entitlement cannot be revoked whatever
    # else has happened to it. Expiry is left exactly where it was.
    await env.DB.prepare(
        "UPDATE course_entitlements SET revoked_at = NULL, revoke_reason = NULL, updated_at = ?2"
        " WHERE id = ?1 AND revoked_at IS NOT NULL"
    ).bind(source["entitlement_id"], now).run()

    await audit(
        env,
        entitlement_id=source["entitlement_id"],
        source_id=source["id"],
        actor=actor,
        action="restore",
        reason=reason,
    )
    return True


async def revoke_source(env, *, fulfillment_id: str, actor: str, reason: str) -> bool:
    """Take back one reason a member has access.

    The access itself only goes when nothing else is paying for it. Somebody
    who bought the same bundle twice and refunded one of them still bought it
    once, and taking the course away would be wrong in a way they would
    notice immediately.
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

    await _revoke_row(env, rows[0], actor=actor, reason=reason)
    return True


async def revoke_by_hand(env, *, customer_id: str, source_id: str, actor: str, reason: str) -> bool:
    """Take back a grant a person made.

    Keyed on the source's own id, because what makes a gift a gift — and a
    re-issue a re-issue — is that no order exists to name it by.

    Excluding `purchase` is a guard, not a filter: a purchase is taken back by
    recording the refund that justifies it, and letting this reach one would put
    somebody's access and their money out of step with each other.

    The member is part of the lookup so a stale page cannot revoke a grant
    belonging to whoever is being read on the screen next door.

    Like every revocation here, this only removes the access itself when this
    was the last live reason for it — a member who was gifted a course they had
    also bought keeps it.
    """

    if not reason:
        raise ValueError("撤銷觀看權必須填寫原因")

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT s.* FROM course_entitlement_sources s"
            " JOIN course_entitlements e ON e.id = s.entitlement_id"
            " WHERE s.id = ?1 AND e.customer_id = ?2 AND s.source_kind IN ('gift', 'manual')"
            " AND s.revoked_at IS NULL"
        ).bind(source_id, customer_id)
    )
    if not rows:
        # Gone, already revoked, somebody else's, or a purchase. The caller
        # cannot act on which, and all four mean the same thing here.
        return False

    await _revoke_row(env, rows[0], actor=actor, reason=reason)
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


async def list_for_customer(env, customer_id: str) -> list[dict]:
    """Everything this member has been given, and why.

    Sources come with it. "Do they still have access" and "what is still
    paying for it" are different questions, and the second is the one that
    matters when a refund is being argued about.

    Course titles come with it too. The back office is where somebody decides
    whether to take access away, and deciding that from a row of opaque ids is
    how the wrong course gets revoked.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM course_entitlements WHERE customer_id = ?1 ORDER BY granted_at DESC LIMIT 200"
        ).bind(customer_id)
    )
    if not rows:
        return []

    course_ids = sorted({row["course_id"] for row in rows})
    course_placeholders = ", ".join(f"?{index + 1}" for index in range(len(course_ids)))
    titles = {
        row["id"]: row["title"]
        for row in await d1_rows(
            env.DB.prepare(
                f"SELECT id, title FROM courses WHERE id IN ({course_placeholders})"
            ).bind(*course_ids)
        )
    }

    placeholders = ", ".join(f"?{index + 1}" for index in range(len(rows)))
    sources = await d1_rows(
        env.DB.prepare(
            f"SELECT * FROM course_entitlement_sources WHERE entitlement_id IN ({placeholders})"
        ).bind(*[row["id"] for row in rows])
    )
    by_entitlement: dict[str, list[dict]] = {}
    for source in sources:
        by_entitlement.setdefault(source["entitlement_id"], []).append(
            {
                "id": source["id"],
                "kind": source["source_kind"],
                "fulfillmentId": source["source_order_fulfillment_id"],
                "actor": source["actor"],
                "reason": source["reason"],
                "revokedAt": source["revoked_at"],
                # Who took it away and why. Somebody deciding whether to put it
                # back needs the reason it went more than they need any other
                # field on this row.
                "revokedBy": source["revoked_by"],
                "revokeReason": source["revoke_reason"],
            }
        )

    # The decisions, which the source row no longer keeps: restoring clears the
    # revocation off it, so without this a course that was revoked and put back
    # would look like nothing had ever happened to it.
    decisions = await history(env, [row["id"] for row in rows])

    now = utc_timestamp()
    listed = []
    for row in rows:
        mapped = entitlement_row(row)
        listed.append(
            {
                **mapped,
                # A course that has since been deleted outright leaves the id
                # standing in for it. Blank would read as a loading fault.
                "courseTitle": titles.get(row["course_id"]) or row["course_id"],
                "active": is_active(mapped, now=now),
                "sources": by_entitlement.get(row["id"], []),
                "history": decisions.get(row["id"], []),
            }
        )
    return listed


async def revoke_order_courses(
    env, *, order_id: str, actor: str, reason: str, fulfillment_ids: list[str] | None = None
) -> int:
    """Take back what an order granted, in whole or by name.

    `fulfillment_ids` of None means everything this order granted — a full
    refund. A partial one has to name them: working out which course a member
    loses from the amount refunded would be guessing, and the thing being
    guessed at is somebody's access.

    Returns how many sources were actually revoked, so the caller can tell
    "nothing to do" from "done".
    """

    if not reason:
        raise ValueError("撤銷觀看權必須填寫原因")

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM order_fulfillments WHERE order_id = ?1 AND fulfillment_type = 'course'"
        ).bind(order_id)
    )
    wanted = [
        row for row in rows if fulfillment_ids is None or row["id"] in set(fulfillment_ids)
    ]

    revoked = 0
    for row in wanted:
        if await revoke_source(env, fulfillment_id=row["id"], actor=actor, reason=reason):
            revoked += 1
    return revoked
