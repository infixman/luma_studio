"""Finding what the happy path dropped.

Every query here exists because a step that should have happened might not
have. A payment lands and the grant fails. An order expires and the sweep that
should have released its stock never ran. A container dies holding a job.
None of that is rare enough to leave to chance, and all of it is invisible
unless something goes looking.

These functions only *find*. Fixing is the job of the code that already knows
how — `provision_paid_order`, `release_stock`, and so on — because a repair
written twice is a repair that behaves two ways.

The queries are deliberately narrow. A sweep that returns everything is a
sweep nobody dares run, and one that quietly fixes things nobody asked about
is worse.
"""

from shared.common import d1_rows


# How long a transcode may go without reporting before it is presumed dead.
# Long enough for a genuinely slow encode of a long lesson; short enough that
# a container which vanished does not hold its version overnight.
TRANSCODE_LEASE_SECONDS = 2 * 60 * 60

# Nothing here pages. These lists should be short, and one that is not is
# itself the finding.
MAX_ROWS = 200


async def orders_missing_grants(env) -> list[str]:
    """Paid orders with a course fulfilment that never landed.

    The one failure a customer feels immediately and cannot work around: they
    paid, and the course is not there.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT DISTINCT o.id FROM orders o"
            " JOIN order_fulfillments f ON f.order_id = o.id"
            " WHERE o.status = 'paid' AND f.fulfillment_type = 'course' AND f.status != 'fulfilled'"
            f" LIMIT {MAX_ROWS}"
        )
    )
    return [row["id"] for row in rows]


async def orders_holding_stock_past_expiry(env, *, now: int) -> list[str]:
    """Pending orders whose hold ran out and whose stock is still spoken for.

    The cron does this every five minutes. This finds the ones it missed —
    a deploy during the sweep, an isolate that died halfway.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT id FROM orders WHERE status = 'pending' AND reserved_until IS NOT NULL"
            f" AND reserved_until < ?1 LIMIT {MAX_ROWS}"
        ).bind(now)
    )
    return [row["id"] for row in rows]


async def stuck_transcodes(env, *, now: int) -> list[dict]:
    """Encodes that stopped reporting.

    A container that died holding a job leaves it `processing` forever, and
    the unique index means no retry can take that version until it is cleared.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT id, asset_id FROM video_transcode_jobs WHERE status = 'processing'"
            f" AND started_at IS NOT NULL AND started_at < ?1 LIMIT {MAX_ROWS}"
        ).bind(now - TRANSCODE_LEASE_SECONDS)
    )
    return [{"jobId": row["id"], "assetId": row["asset_id"]} for row in rows]


async def entitlements_without_live_sources(env) -> list[str]:
    """Access whose every reason has been revoked.

    A refund revokes the source; the grant is only revoked when it was the
    last one. If that second step failed, somebody is watching a course they
    were refunded for, and nothing in the normal flow will ever notice.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT e.id FROM course_entitlements e"
            " WHERE e.revoked_at IS NULL AND NOT EXISTS ("
            "   SELECT 1 FROM course_entitlement_sources s"
            "   WHERE s.entitlement_id = e.id AND s.revoked_at IS NULL"
            f" ) LIMIT {MAX_ROWS}"
        )
    )
    return [row["id"] for row in rows]


async def orphan_purchase_locks(env) -> list[dict]:
    """Locks whose order no longer exists or never paid.

    Harmless-looking and quietly awful: the member is told they already own
    something they do not, and there is nothing they can do about it from
    their side.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT l.customer_id, l.offer_id FROM course_offer_purchase_locks l"
            " LEFT JOIN orders o ON o.id = l.order_id"
            " WHERE o.id IS NULL OR o.status IN ('cancelled', 'expired')"
            f" LIMIT {MAX_ROWS}"
        )
    )
    return [{"customerId": row["customer_id"], "offerId": row["offer_id"]} for row in rows]
