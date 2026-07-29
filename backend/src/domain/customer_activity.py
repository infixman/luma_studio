"""Small, explicit activity records for signed-in customers.

This is not anonymous traffic analytics. A row is accepted only after the
customer session has been verified, and records only the page or product
needed by the shop's member-support view.
"""

from shared.common import d1_rows, urlsafe_token, utc_timestamp


EVENT_TYPES = ("page_view", "product_view", "cart_add")
MAX_PATH = 240
MAX_PRODUCT = 120
RECENT_DAYS = 30
RETENTION_DAYS = 180


def event_row(row: dict) -> dict:
    return {
        "type": row["event_type"],
        "path": row["path"],
        "productSlug": row["product_slug"],
        "productTitle": row["product_title"],
        "quantity": int(row["quantity"]) if row["quantity"] is not None else None,
        "createdAt": int(row["created_at"]),
    }


async def record(
    env,
    customer_id: str,
    *,
    event_type: str,
    path: str = "",
    product_slug: str = "",
    product_title: str = "",
    quantity: int | None = None,
) -> None:
    if event_type not in EVENT_TYPES:
        raise ValueError("Invalid customer event")
    clean_path = str(path or "")[:MAX_PATH]
    if clean_path and (not clean_path.startswith("/") or clean_path.startswith("//")):
        raise ValueError("Invalid customer event path")
    clean_slug = str(product_slug or "")[:MAX_PRODUCT]
    clean_title = str(product_title or "")[:MAX_PRODUCT]
    if event_type in ("product_view", "cart_add") and not clean_slug:
        raise ValueError("Product event needs a product")
    clean_quantity = None
    if event_type == "cart_add":
        clean_quantity = int(quantity or 0)
        if clean_quantity < 1 or clean_quantity > 100000:
            raise ValueError("Invalid cart quantity")

    now = utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO customer_events"
        " (id, customer_id, event_type, path, product_slug, product_title, quantity, created_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    ).bind(
        urlsafe_token(18),
        customer_id,
        event_type,
        clean_path,
        clean_slug,
        clean_title,
        clean_quantity,
        now,
    ).run()
    # The support view is intentionally recent; silently accumulating a
    # lifetime browsing history would exceed both that purpose and its need.
    await env.DB.prepare(
        "DELETE FROM customer_events WHERE customer_id = ?1 AND created_at < ?2"
    ).bind(customer_id, now - RETENTION_DAYS * 24 * 60 * 60).run()


async def recent(env, customer_id: str, *, limit: int = 50) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM customer_events WHERE customer_id = ?1"
            " ORDER BY created_at DESC LIMIT ?2"
        ).bind(customer_id, max(1, min(int(limit), 100)))
    )
    return [event_row(row) for row in rows]


async def summary(env, customer_id: str) -> dict:
    since = utc_timestamp() - RECENT_DAYS * 24 * 60 * 60
    rows = await d1_rows(
        env.DB.prepare(
            """SELECT MAX(created_at) AS last_seen_at,
                      SUM(CASE WHEN event_type = 'page_view' THEN 1 ELSE 0 END) AS page_views,
                      SUM(CASE WHEN event_type = 'product_view' THEN 1 ELSE 0 END) AS product_views,
                      SUM(CASE WHEN event_type = 'cart_add' THEN 1 ELSE 0 END) AS cart_adds
                 FROM customer_events
                WHERE customer_id = ?1 AND created_at >= ?2"""
        ).bind(customer_id, since)
    )
    row = rows[0] if rows else {}
    return {
        "periodDays": RECENT_DAYS,
        "lastSeenAt": int(row["last_seen_at"]) if row.get("last_seen_at") is not None else None,
        "pageViews": int(row.get("page_views") or 0),
        "productViews": int(row.get("product_views") or 0),
        "cartAdds": int(row.get("cart_adds") or 0),
    }
