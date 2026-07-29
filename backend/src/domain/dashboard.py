"""What the shop looks like right now, in one request.

The back office opened on the ibon print tool, which is a tool — useful, and
not what anybody needs to know first thing in the morning. This answers the
questions the owner actually arrives with: is anybody waiting for a parcel,
is anything about to sell out, and did last month happen.

Every figure here is a count or a sum the database can do itself. Nothing is
assembled by reading rows into Python and adding them up: the page is opened
often and it must not get slower as the shop gets busier.
"""

from shared.common import d1_rows, utc_timestamp


# Below this many left, a variant is worth being told about. Not zero, because
# by the time it is zero the decision to restock is already late.
LOW_STOCK_AT = 3

# How far back "recently edited" reaches. Long enough to still find the thing
# you were doing on Friday when you come back on Monday.
RECENT_DAYS = 14

MAX_RECENT = 6
MAX_LOW_STOCK = 8


async def summary(env) -> dict:
    """Everything the dashboard shows. One call, because it is one screen."""

    now = utc_timestamp()
    month_start = now - 30 * 24 * 60 * 60

    return {
        "orders": await _order_counts(env),
        "revenue": await _revenue(env, month_start),
        "lowStock": await _low_stock(env),
        "recentPages": await _recent_pages(env, now - RECENT_DAYS * 24 * 60 * 60),
        "lowStockAt": LOW_STOCK_AT,
    }


async def _order_counts(env) -> dict:
    """How many orders sit in each state, and how many need the owner to act.

    `waiting` is the number this page exists for: paid but not yet shipped is
    somebody who has given the shop money and is now waiting for a parcel.
    """

    rows = await d1_rows(env.DB.prepare("SELECT status, COUNT(*) AS total FROM orders GROUP BY status"))
    counts = {row["status"]: int(row["total"]) for row in rows}
    return {
        "pending": counts.get("pending", 0),
        "paid": counts.get("paid", 0),
        "shipped": counts.get("shipped", 0),
        "completed": counts.get("completed", 0),
        # Paid and not yet gone. The one number worth acting on today.
        "waiting": counts.get("paid", 0),
    }


async def _revenue(env, since: int) -> dict:
    """Money actually taken in the last thirty days.

    Counted from `paid_at`, not `created_at`: an order placed in March and
    paid in April is April's money. Cancelled and expired orders never had a
    `paid_at`, so they fall out without needing to be named.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total"
            " FROM orders WHERE paid_at IS NOT NULL AND paid_at >= ?1"
        ).bind(since)
    )
    row = rows[0] if rows else {}
    return {"orders": int(row.get("orders") or 0), "total": int(row.get("total") or 0)}


async def _low_stock(env) -> list[dict]:
    """Variants close to running out, on sale, worst first.

    Disabled variants and products that are not on sale are left out: a
    product nobody can buy cannot disappoint anybody by being out of stock.

    `active` is the shop's word — see shop.PRODUCT_STATUSES. `published` is the
    pages vocabulary, and it was what this said until somebody noticed the
    panel was permanently empty. Two vocabularies, one wrong literal, and no
    error anywhere: the query simply matched nothing.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT v.id, v.title AS variant_title, v.stock, p.title AS product_title, p.slug"
            " FROM product_variants v"
            " JOIN products p ON p.id = v.product_id"
            " WHERE v.enabled = 1 AND p.status = 'active' AND v.stock <= ?1"
            " ORDER BY v.stock, p.title LIMIT ?2"
        ).bind(LOW_STOCK_AT, MAX_LOW_STOCK)
    )
    return [
        {
            "id": row["id"],
            "productTitle": row["product_title"],
            "variantTitle": row["variant_title"],
            "slug": row["slug"],
            "stock": int(row["stock"]),
        }
        for row in rows
    ]


async def _recent_pages(env, since: int) -> list[dict]:
    """What was being worked on, so it can be picked back up."""

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT id, title, path, status, is_home, updated_at FROM pages"
            " WHERE updated_at >= ?1 ORDER BY updated_at DESC LIMIT ?2"
        ).bind(since, MAX_RECENT)
    )
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "path": "/" if int(row["is_home"] or 0) else row["path"],
            "status": row["status"],
            "updatedAt": int(row["updated_at"]),
        }
        for row in rows
    ]
