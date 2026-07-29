"""Physical stock, owned by nothing that has a price.

A `product_variants` row used to be both the offer a customer buys and the
count in the stockroom. That works only while the two are one-to-one. As soon
as one material kit is sold on its own and also included in two course
bundles, three offers are drawing on a single pile, and a count that lives on
one of them cannot be right for the other two.

So stock moves here. An InventoryItem has no price, no product page and no
opinion about how it is sold; it is a thing there are some of. Offers point at
it through `offer_components`.

Every deduction is a conditional UPDATE rather than a read followed by a
write. D1 has no interactive transaction, so those two statements have a gap
another request fits through, and the gap is exactly where overselling
happens.
"""

from shared.common import d1_changed, d1_rows, escape_like, urlsafe_token, utc_timestamp, validate_text


MAX_TITLE = 80
MAX_SKU = 40
MAX_STOCK = 100000


def validate_title(value) -> str:
    return validate_text(value, MAX_TITLE, "Title")


def validate_sku(value) -> str:
    """Blank is allowed: not everything in a stockroom has a code."""

    return validate_text(value or "", MAX_SKU, "SKU", required=False)


def validate_stock(value) -> int:
    """Reject anything that is not already a whole number.

    `int(value)` would read 12.7 as 12 and "0012" as 12. Stock arriving in the
    wrong shape is a bug in the caller, and truncating it hides that until the
    count is wrong.
    """

    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Stock must be a whole number")
    if value < 0 or value > MAX_STOCK:
        raise ValueError(f"Stock must be between 0 and {MAX_STOCK}")
    return value


def item_row(row: dict) -> dict:
    """The editor is told whether an item is archived, not when.

    The timestamp is an operational detail; exposing it invites the client to
    compute the state itself and get a different answer.
    """

    return {
        "id": row["id"],
        "sku": row["sku"],
        "title": row["title"],
        "stock": int(row["stock"]),
        "enabled": bool(row["enabled"]),
        "archived": row.get("archived_at") is not None,
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


async def list_items(env, *, search: str = "", enabled_only: bool = False) -> list[dict]:
    query = "SELECT * FROM inventory_items WHERE archived_at IS NULL"
    bindings: list = []
    if enabled_only:
        query += " AND enabled = 1"
    if search:
        bindings.append(f"%{escape_like(search)}%")
        query += f" AND (title LIKE ?{len(bindings)} ESCAPE '\\' OR sku LIKE ?{len(bindings)} ESCAPE '\\')"
    query += " ORDER BY title"
    return [item_row(row) for row in await d1_rows(env.DB.prepare(query).bind(*bindings))]


async def get_item(env, item_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM inventory_items WHERE id = ?1").bind(item_id))
    return item_row(rows[0]) if rows else None


async def sku_taken(env, sku: str, *, excluding: str | None = None) -> bool:
    """A blank SKU is never a conflict, so it is not even asked about."""

    if not sku:
        return False
    query = "SELECT id FROM inventory_items WHERE sku = ?1"
    bindings: list = [sku]
    if excluding is not None:
        query += " AND id != ?2"
        bindings.append(excluding)
    return bool(await d1_rows(env.DB.prepare(query).bind(*bindings)))


async def create_item(env, *, title: str, sku: str, stock: int, enabled: bool) -> str:
    item_id, now = urlsafe_token(18), utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO inventory_items (id, sku, title, stock, enabled, archived_at, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)"
    ).bind(item_id, sku, title, stock, 1 if enabled else 0, now).run()
    return item_id


async def update_item(env, item_id: str, *, title: str, sku: str, stock: int, enabled: bool) -> bool:
    result = await env.DB.prepare(
        "UPDATE inventory_items SET title = ?2, sku = ?3, stock = ?4, enabled = ?5, updated_at = ?6"
        " WHERE id = ?1 AND archived_at IS NULL"
    ).bind(item_id, title, sku, stock, 1 if enabled else 0, utc_timestamp()).run()
    return d1_changed(result)


async def archive_item(env, item_id: str) -> bool:
    """Archive rather than delete: order fulfilment snapshots name this row."""

    now = utc_timestamp()
    result = await env.DB.prepare(
        "UPDATE inventory_items SET archived_at = ?2, enabled = 0, updated_at = ?2"
        " WHERE id = ?1 AND archived_at IS NULL"
    ).bind(item_id, now).run()
    return d1_changed(result)


async def adjust_stock(env, item_id: str, stock: int) -> dict | None:
    """Set a count deliberately, and report what it was.

    Separate from `take_stock` because these are different events. An order
    taking two is the system doing its job; an admin typing 12 is a claim
    about the physical world that someone may later need to question. Without
    the previous value the audit line says "stock set to 12", which cannot be
    argued with because it says nothing.

    Returns None when the item is gone, so the caller can answer 404 rather
    than reporting a successful adjustment of nothing.
    """

    existing = await get_item(env, item_id)
    if existing is None:
        return None
    await env.DB.prepare(
        "UPDATE inventory_items SET stock = ?2, updated_at = ?3 WHERE id = ?1"
    ).bind(item_id, stock, utc_timestamp()).run()
    return {"before": existing["stock"], "after": stock}


async def take_stock(env, item_id: str, quantity: int) -> bool:
    """Deduct only if there is enough, in one statement. False means there was not."""

    result = await env.DB.prepare(
        "UPDATE inventory_items SET stock = stock - ?2, updated_at = ?3"
        " WHERE id = ?1 AND enabled = 1 AND archived_at IS NULL AND stock >= ?2"
    ).bind(item_id, quantity, utc_timestamp()).run()
    return d1_changed(result)


async def give_back_stock(env, item_id: str, quantity: int) -> None:
    """Return reserved stock unconditionally.

    Deliberately not filtered by `enabled` or `archived_at`. An order that
    took stock before the item was withdrawn still has to be able to put it
    back, or the count stays short for good.
    """

    await env.DB.prepare(
        "UPDATE inventory_items SET stock = stock + ?2, updated_at = ?3 WHERE id = ?1"
    ).bind(item_id, quantity, utc_timestamp()).run()
