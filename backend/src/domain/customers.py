"""Customers, from the shop's side.

The customer-facing code only ever looks at whoever is signed in, so it never
needed to list anybody. The back office does: to answer "who is this order
from", to stop an account that is abusing checkout, and to erase someone who
asks to be erased.

Erasing is not deleting. The order rows have to survive — they are the shop's
own accounts, and a receipt from March cannot vanish because the buyer asked
to be forgotten in June. So the personal fields are overwritten and the row
stays, with `anonymized_at` recording when.
"""

from shared import paging
from shared.common import d1_changed, d1_rows, escape_like, utc_timestamp


MAX_SEARCH = 60

# What is left of someone after they ask to be forgotten. Not empty strings:
# a blank name on an order looks like a bug, and someone will go looking for
# the data that "went missing".
ERASED = "（已刪除）"


def validate_customer_id(customer_id: str) -> str:
    raw = str(customer_id)
    if not 6 <= len(raw) <= 60 or not all(character.isalnum() or character in "_-" for character in raw):
        raise ValueError("Invalid customer id")
    return raw


def customer_admin_row(row: dict) -> dict:
    """One customer as the shop sees them, including the counts beside them."""

    return {
        "id": row["id"],
        "email": row["email"],
        "displayName": row["display_name"],
        "recipientName": row["default_recipient_name"],
        "recipientPhone": row["default_recipient_phone"],
        "address": row["default_address"],
        "blocked": bool(row["blocked"]),
        "cartBlocked": bool(row["blocked"]),
        "accountBlocked": bool(row.get("account_blocked") or 0),
        "notes": row.get("notes") or "",
        "anonymizedAt": int(row["anonymized_at"]) if row["anonymized_at"] is not None else None,
        "createdAt": int(row["created_at"]),
        "orderCount": int(row["order_count"]) if "order_count" in row else 0,
        "paidTotal": int(row["paid_total"] or 0) if "paid_total" in row else 0,
    }


# The counts come from the same query as the list. Asking per customer would
# be one round trip per row, and D1 charges for every one of them.
_LIST_QUERY = """
    SELECT c.*,
           COUNT(o.id) AS order_count,
           COALESCE(SUM(CASE WHEN o.status IN ('paid', 'shipped', 'completed') THEN o.total END), 0) AS paid_total
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
"""


async def list_all(
    env, *, search: str = "", page: int = 1, per_page: int = paging.DEFAULT_PER_PAGE
) -> tuple[list[dict], int]:
    """One page of members, and how many there are altogether."""

    bindings = []
    where = ""
    if search:
        # LIKE's own wildcards, made literal: searching for `a_b` must not
        # also answer with `axb`.
        term = escape_like(search[:MAX_SEARCH])
        bindings.append(f"%{term}%")
        where = (
            r" WHERE c.email LIKE ?1 ESCAPE '\' OR c.display_name LIKE ?1 ESCAPE '\'"
            r" OR c.default_recipient_name LIKE ?1 ESCAPE '\'"
        )

    counted = await d1_rows(env.DB.prepare(f"SELECT COUNT(*) AS total FROM customers c{where}").bind(*bindings))
    total = int(counted[0]["total"]) if counted else 0

    limit, offset = paging.window(page, per_page)
    bindings.append(limit)
    bindings.append(offset)
    query = (
        f"{_LIST_QUERY}{where} GROUP BY c.id ORDER BY c.created_at DESC"
        f" LIMIT ?{len(bindings) - 1} OFFSET ?{len(bindings)}"
    )
    rows = await d1_rows(env.DB.prepare(query).bind(*bindings))
    return [customer_admin_row(row) for row in rows], total


async def get(env, customer_id: str) -> dict | None:
    rows = await d1_rows(
        env.DB.prepare(f"{_LIST_QUERY} WHERE c.id = ?1 GROUP BY c.id").bind(customer_id)
    )
    return customer_admin_row(rows[0]) if rows else None


async def set_blocked(env, customer_id: str, blocked: bool) -> bool:
    """Stop or allow cart validation and checkout for one account.

    Blocking does not sign anyone out. They can still read the orders they
    already placed, which is the difference between refusing a sale and
    confiscating a receipt.
    """

    result = await (
        env.DB.prepare("UPDATE customers SET blocked = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(customer_id, 1 if blocked else 0, utc_timestamp())
        .run()
    )
    return d1_changed(result)


async def set_account_blocked(env, customer_id: str, blocked: bool) -> bool:
    """Suspend sign-in separately from shopping access.

    A suspension ends current sessions immediately. Restoring the account
    allows the next Google sign-in; it does not fabricate a session.
    """

    result = await (
        env.DB.prepare("UPDATE customers SET account_blocked = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(customer_id, 1 if blocked else 0, utc_timestamp())
        .run()
    )
    changed = d1_changed(result)
    if changed and blocked:
        await env.DB.prepare("DELETE FROM customer_sessions WHERE customer_id = ?1").bind(customer_id).run()
    return changed


MAX_DISPLAY_NAME = 60


async def update_profile(
    env,
    customer_id: str,
    *,
    display_name: str,
    recipient_name: str,
    recipient_phone: str,
    address: str,
) -> bool:
    result = await (
        env.DB.prepare(
            "UPDATE customers SET display_name = ?2, default_recipient_name = ?3,"
            " default_recipient_phone = ?4, default_address = ?5, updated_at = ?6"
            " WHERE id = ?1 AND anonymized_at IS NULL"
        )
        .bind(
            customer_id,
            str(display_name).strip()[:MAX_DISPLAY_NAME],
            recipient_name,
            recipient_phone,
            address,
            utc_timestamp(),
        )
        .run()
    )
    return d1_changed(result)


MAX_NOTES = 2000


async def set_notes(env, customer_id: str, notes: str) -> bool:
    text = str(notes or "")[:MAX_NOTES]
    result = await (
        env.DB.prepare("UPDATE customers SET notes = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(customer_id, text, utc_timestamp())
        .run()
    )
    return d1_changed(result)


async def anonymise(env, customer_id: str) -> bool:
    """Overwrite everything personal, keep the row and the orders.

    `google_sub` is overwritten too, so signing in with the same Google
    account afterwards creates a new customer rather than resurrecting this
    one. Sessions go, because a live session would keep serving the old
    profile from a row that no longer holds it.

    What this does not touch: the name, phone and address on orders already
    placed. Those are the shop's transaction record — the thing the tax
    authority asks for — and they are a snapshot of a delivery that happened,
    not a profile. Scrubbing them as well is a decision about how long to keep
    accounts, which is the owner's to make and is not made here.
    """

    now = utc_timestamp()
    result = await (
        env.DB.prepare(
            """UPDATE customers
                  SET email = ?2, display_name = ?3, default_recipient_name = ?3,
                      default_recipient_phone = '', default_address = '',
                      google_sub = ?4, anonymized_at = ?5, updated_at = ?5
                WHERE id = ?1 AND anonymized_at IS NULL"""
        )
        .bind(customer_id, f"erased+{customer_id}@invalid", ERASED, f"erased:{customer_id}", now)
        .run()
    )
    changed = d1_changed(result)
    if changed:
        await env.DB.prepare("DELETE FROM customer_sessions WHERE customer_id = ?1").bind(customer_id).run()
    return changed
