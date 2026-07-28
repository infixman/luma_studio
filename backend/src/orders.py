"""Creating orders, holding stock for them, and letting go again.

Stock is decremented when the order is created, not when it is paid. Waiting
for payment means two people can buy the last one; holding it forever means a
cart nobody finished takes an item off the shelf permanently. So the hold has
an expiry, and a sweep puts back what was never paid for.

D1 has no interactive transactions. The decrement is therefore a conditional
UPDATE whose affected-row count is the answer: one row means the stock was
there and is now reserved, zero means somebody else got it first. That check
is the only thing standing between this shop and overselling, so it is
written once, here.
"""

import re

import shipping
import shop
import mail
from common import d1_rows, random_alpha_numeric, utc_timestamp


ORDER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,25}$")

# How long an unpaid order keeps its stock. PAYUNi's payment page expires
# after at most ten minutes, so fifteen leaves room for a slow payer without
# stranding the item for an afternoon.
RESERVATION_SECONDS = 15 * 60

# The back office reads a page at a time; nothing here pages through a year.
MAX_LIST = 200

STATUSES = ("pending", "paid", "shipped", "completed", "cancelled", "expired")
# The states in which stock is still spoken for. Leaving any of these puts it
# back; every caller goes through `release_stock` rather than deciding alone.
HOLDING_STOCK = ("pending", "paid", "shipped")

MAX_RECIPIENT_NAME = 25
MAX_PHONE = 20
MAX_ADDRESS = 200

# PAYUNi rejects a name with an emoji in it, and does so at the point of
# creating a shipment — long after the money has moved. Catching it here
# costs a form error instead of a stuck parcel.
NAME_PATTERN = re.compile(r"^[一-鿿A-Za-z0-9·・\.\-\s]+$")
PHONE_PATTERN = re.compile(r"^09\d{8}$")


class OrderError(Exception):
    """Something about the request makes the order impossible to place."""


def validate_recipient_name(value: str) -> str:
    value = " ".join(str(value).split())
    if not value:
        raise OrderError("請填寫收件人姓名")
    if len(value) > MAX_RECIPIENT_NAME:
        raise OrderError(f"收件人姓名請控制在 {MAX_RECIPIENT_NAME} 個字以內")
    if not NAME_PATTERN.fullmatch(value):
        raise OrderError("收件人姓名只能使用中文、英文或數字，不能包含表情符號")
    return value


def validate_phone(value: str) -> str:
    value = str(value).strip().replace("-", "").replace(" ", "")
    if not PHONE_PATTERN.fullmatch(value):
        raise OrderError("請填寫 09 開頭的十碼手機號碼")
    return value


def validate_address(value: str, *, required: bool) -> str:
    value = " ".join(str(value).split())
    if required and not value:
        raise OrderError("宅配需要填寫收件地址")
    if len(value) > MAX_ADDRESS:
        raise OrderError(f"收件地址請控制在 {MAX_ADDRESS} 個字以內")
    return value


def validate_email(value: str) -> str:
    value = str(value).strip()
    if "@" not in value or len(value) > 200:
        raise OrderError("請填寫可以收到通知的電子信箱")
    return value


def new_order_id(day: str) -> str:
    """`LS` + the date + noise, inside PAYUNi's 25-character limit.

    The gateway also refuses anything outside [A-Za-z0-9_-], so the alphabet
    is constrained rather than merely short.
    """

    return f"LS{day}{random_alpha_numeric(7)}"


def order_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "status": row["status"],
        "subtotal": int(row["subtotal"]),
        "shippingFee": int(row["shipping_fee"]),
        "total": int(row["total"]),
        "shippingMethod": row["shipping_method"],
        "recipientName": row["recipient_name"],
        "recipientPhone": row["recipient_phone"],
        "recipientEmail": row["recipient_email"],
        "shippingAddress": row["shipping_address"],
        "storeName": row["store_name"],
        "storeAddr": row["store_addr"],
        "reservedUntil": int(row["reserved_until"]) if row["reserved_until"] is not None else None,
        "paidAt": int(row["paid_at"]) if row["paid_at"] is not None else None,
        "createdAt": int(row["created_at"]),
    }


def item_row(row: dict) -> dict:
    return {
        "productTitle": row["product_title"],
        "variantTitle": row["variant_title"],
        "unitPrice": int(row["unit_price"]),
        "quantity": int(row["quantity"]),
        "subtotal": int(row["subtotal"]),
    }


def card_item_row(row: dict) -> dict:
    """A line, plus enough to show a picture of it and link back to the product.

    The title and the price come from the order; the picture and the link come
    from the product as it is today. That is deliberate, and the two must not
    be confused: a receipt from March may not change because the shop renamed
    something in June, whereas the thumbnail is only there to help someone
    recognise what they bought. A product that has since been deleted leaves
    both null, and the line still reads correctly without them.
    """

    return {
        **item_row(row),
        "slug": row["product_slug"],
        "coverPath": shop.image_path(row["cover_key"]) if row["cover_key"] else None,
    }


def admin_row(row: dict) -> dict:
    """The same order plus what only the shop may see.

    A separate function rather than a field on `order_row`, because that one
    is what a customer is handed. A private note added to the shared shape is
    a private note published on someone's order page.
    """

    return {**order_row(row), "customerId": row["customer_id"], "adminNote": row["admin_note"]}


async def audit(env, order_id: str, actor: str, action: str, *, before=None, after=None, detail: str = "") -> None:
    await env.DB.prepare(
        "INSERT INTO order_audit_log (order_id, actor, action, from_status, to_status, detail, created_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    ).bind(order_id, actor, action, before, after, detail, utc_timestamp()).run()


async def take_stock(env, variant_id: str, quantity: int) -> bool:
    """Reserve `quantity` of a variant, or report that it is no longer there.

    The WHERE clause carries the check, so two requests racing for the last
    item cannot both read "1 available" and both succeed. Whichever UPDATE
    lands second matches no rows.
    """

    result = await (
        env.DB.prepare("UPDATE product_variants SET stock = stock - ?2 WHERE id = ?1 AND stock >= ?2")
        .bind(variant_id, quantity)
        .run()
    )
    # D1 reports this as meta.changes; a driver that does not is treated as a
    # failure rather than assumed to have worked.
    try:
        return int(result.meta.changes) == 1
    except (AttributeError, TypeError, ValueError):
        return False


async def give_back_stock(env, variant_id: str, quantity: int) -> None:
    await env.DB.prepare("UPDATE product_variants SET stock = stock + ?2 WHERE id = ?1").bind(
        variant_id, quantity
    ).run()


async def create_order(env, customer: dict, *, priced: dict, method: dict, recipient: dict, day: str) -> dict:
    """Place an order, taking the stock for it as we go.

    Anything that fails part-way puts back what it already took. Without that,
    a customer whose last line sold out mid-checkout would silently remove the
    earlier lines from sale.
    """

    if not priced["lines"]:
        raise OrderError("購物車是空的")

    taken: list[tuple[str, int]] = []
    for line in priced["lines"]:
        if await take_stock(env, line["variantId"], line["quantity"]):
            taken.append((line["variantId"], line["quantity"]))
            continue
        for variant_id, quantity in taken:
            await give_back_stock(env, variant_id, quantity)
        raise OrderError(f"「{line['productTitle']}」剛剛被買走了，請重新確認購物車")

    now = utc_timestamp()
    subtotal = priced["subtotal"]
    fee = shipping.fee_for(method, subtotal)
    order_id = new_order_id(day)

    await env.DB.prepare(
        "INSERT INTO orders (id, customer_id, status, subtotal, shipping_fee, total, shipping_method,"
        " recipient_name, recipient_phone, recipient_email, shipping_address, reserved_until, created_at, updated_at)"
        " VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)"
    ).bind(
        order_id,
        customer["id"],
        subtotal,
        fee,
        subtotal + fee,
        method["method"],
        recipient["name"],
        recipient["phone"],
        recipient["email"],
        recipient["address"],
        now + RESERVATION_SECONDS,
        now,
    ).run()

    for line in priced["lines"]:
        await env.DB.prepare(
            "INSERT INTO order_items (id, order_id, variant_id, product_title, variant_title, unit_price,"
            " quantity, subtotal) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        ).bind(
            random_alpha_numeric(20),
            order_id,
            line["variantId"],
            line["productTitle"],
            line["variantTitle"],
            line["unitPrice"],
            line["quantity"],
            line["lineTotal"],
        ).run()

    await audit(env, order_id, f"customer:{customer['id']}", "created", after="pending")
    return await get_order(env, order_id)


async def get_order(env, order_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(order_id))
    return order_row(rows[0]) if rows else None


async def get_order_for_admin(env, order_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(order_id))
    return admin_row(rows[0]) if rows else None


async def list_items(env, order_id: str) -> list[dict]:
    return [
        item_row(row)
        for row in await d1_rows(env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?1").bind(order_id))
    ]


# Every join is a LEFT one: a deleted product must not delete the line that
# says somebody bought it. The cover is whichever image the product shows
# first, read as a subquery so a product with four photos still yields one row
# per order line rather than four.
_ITEM_WITH_PRODUCT = (
    "SELECT oi.*, p.slug AS product_slug,"
    " (SELECT r2_key FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS cover_key"
    " FROM order_items oi"
    " LEFT JOIN product_variants pv ON pv.id = oi.variant_id"
    " LEFT JOIN products p ON p.id = pv.product_id"
)


async def list_card_items(env, order_id: str) -> list[dict]:
    return [
        card_item_row(row)
        for row in await d1_rows(env.DB.prepare(f"{_ITEM_WITH_PRODUCT} WHERE oi.order_id = ?1").bind(order_id))
    ]


async def list_for_customer(env, customer_id: str) -> list[dict]:
    return [
        order_row(row)
        for row in await d1_rows(
            env.DB.prepare("SELECT * FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC").bind(customer_id)
        )
    ]


async def list_cards_for_customer(env, customer_id: str) -> list[dict]:
    """Every order the customer has placed, each carrying its own lines.

    The lines arrive in one query for the whole list rather than one query per
    order: a customer with twenty orders would otherwise cost twenty-one round
    trips to show a page that is mostly thumbnails.
    """

    orders_ = await list_for_customer(env, customer_id)
    if not orders_:
        return []

    lines: dict[str, list[dict]] = {order["id"]: [] for order in orders_}
    rows = await d1_rows(
        env.DB.prepare(
            f"{_ITEM_WITH_PRODUCT} WHERE oi.order_id IN (SELECT id FROM orders WHERE customer_id = ?1)"
        ).bind(customer_id)
    )
    for row in rows:
        # An order that arrived between the two queries has no entry here, and
        # its lines are dropped rather than crashing the list.
        if row["order_id"] in lines:
            lines[row["order_id"]].append(card_item_row(row))

    return [{**order, "items": lines[order["id"]]} for order in orders_]


async def release_stock(env, order_id: str) -> None:
    """Put an order's items back on the shelf."""

    rows = await d1_rows(
        env.DB.prepare("SELECT variant_id, quantity FROM order_items WHERE order_id = ?1").bind(order_id)
    )
    for row in rows:
        await give_back_stock(env, row["variant_id"], int(row["quantity"]))


async def mark_paid(env, order_id: str, actor: str, *, detail: str = "") -> bool:
    """Move a pending order to paid, once.

    The status is part of the WHERE clause so a duplicated notification —
    which every payment gateway will eventually send — cannot advance an
    order twice or resurrect one that expired.
    """

    now = utc_timestamp()
    result = await (
        env.DB.prepare(
            "UPDATE orders SET status = 'paid', paid_at = ?2, reserved_until = NULL, updated_at = ?2"
            " WHERE id = ?1 AND status = 'pending'"
        )
        .bind(order_id, now)
        .run()
    )
    try:
        changed = int(result.meta.changes) == 1
    except (AttributeError, TypeError, ValueError):
        changed = False
    if changed:
        await audit(env, order_id, actor, "paid", before="pending", after="paid", detail=detail)
        await _tell_customer(env, order_id, "paid")
    return changed


# What the shop is allowed to do to an order, and from where. Written as a
# table because the interesting part is which move is missing: nothing goes
# backwards, and nothing skips paid.
FORWARD = {"shipped": ("paid",), "completed": ("shipped",)}


async def _tell_customer(env, order_id: str, kind: str, *, detail: str = "") -> None:
    """Queue the customer's notice for a change that already happened.

    Deliberately after the write and deliberately not able to undo it: an
    order that moved must stay moved even if the mail could not be written.
    """

    order = await get_order(env, order_id)
    if order is None:
        return
    try:
        await mail.queue_order_event(env, kind, order, await list_items(env, order_id), detail=detail)
    except Exception:
        # A queue that will not accept a row is a problem for the next run,
        # not a reason to fail the move the shop just made.
        pass


async def advance(env, order_id: str, to_status: str, actor: str, *, detail: str = "") -> str | None:
    """Move an order one step forward, returning the status it came from.

    None means the move was refused: the order is gone, or it is not in a
    status this move starts from. The status it was read at goes into the
    WHERE clause, so two people clicking at once produce one move and one
    refusal rather than two audit entries.

    There is no `shipped_at` column. When a move happened is in the audit log,
    which is the record that has to be right the day a payment is disputed.
    """

    allowed = FORWARD.get(to_status)
    if not allowed:
        return None
    order = await get_order(env, order_id)
    if order is None or order["status"] not in allowed:
        return None

    before = order["status"]
    result = await (
        env.DB.prepare("UPDATE orders SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = ?4")
        .bind(order_id, to_status, utc_timestamp(), before)
        .run()
    )
    try:
        changed = int(result.meta.changes) == 1
    except (AttributeError, TypeError, ValueError):
        changed = False
    if not changed:
        return None

    await audit(env, order_id, actor, to_status, before=before, after=to_status, detail=detail)
    await _tell_customer(env, order_id, to_status, detail=detail)
    return before


async def set_note(env, order_id: str, note: str, actor: str) -> bool:
    """The shop's own note on an order — a tracking number, a phone call.

    Audited like everything else here. A note that quietly changed is a note
    nobody can rely on.
    """

    result = await (
        env.DB.prepare("UPDATE orders SET admin_note = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(order_id, note, utc_timestamp())
        .run()
    )
    try:
        changed = int(result.meta.changes) == 1
    except (AttributeError, TypeError, ValueError):
        changed = False
    if changed:
        await audit(env, order_id, actor, "note", detail=note)
    return changed


async def list_all(env, *, status: str = "", search: str = "", limit: int = 50) -> tuple[list[dict], bool]:
    """The shop's own view of its orders, newest first, and whether the answer
    was cut short.

    Search covers the order id, the recipient and the email they gave at
    checkout — the three things someone has in front of them when they write
    in asking about an order.
    """

    conditions, bindings = [], []
    if status:
        bindings.append(status)
        conditions.append(f"status = ?{len(bindings)}")
    if search:
        bindings.append(f"%{search}%")
        index = len(bindings)
        conditions.append(f"(id LIKE ?{index} OR recipient_name LIKE ?{index} OR recipient_email LIKE ?{index})")
    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    wanted = max(1, min(limit, MAX_LIST))
    # One more than asked for. Whether anything was left out is then a fact
    # rather than "we returned exactly the limit, so probably".
    bindings.append(wanted + 1)
    query = f"SELECT * FROM orders{where} ORDER BY created_at DESC, id LIMIT ?{len(bindings)}"
    rows = await d1_rows(env.DB.prepare(query).bind(*bindings))
    return [admin_row(row) for row in rows[:wanted]], len(rows) > wanted


async def counts_by_status(env) -> dict:
    rows = await d1_rows(env.DB.prepare("SELECT status, COUNT(*) AS total FROM orders GROUP BY status"))
    return {row["status"]: int(row["total"]) for row in rows}


async def list_audit(env, order_id: str) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM order_audit_log WHERE order_id = ?1 ORDER BY created_at, rowid"
        ).bind(order_id)
    )
    return [
        {
            "actor": row["actor"],
            "action": row["action"],
            "fromStatus": row["from_status"],
            "toStatus": row["to_status"],
            "detail": row["detail"],
            "createdAt": int(row["created_at"]),
        }
        for row in rows
    ]


async def list_attempts(env, order_id: str) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM payment_attempts WHERE order_id = ?1 ORDER BY created_at").bind(order_id)
    )
    return [
        {
            "merTradeNo": row["mer_trade_no"],
            "amount": int(row["amount"]),
            "status": row["status"],
            "createdAt": int(row["created_at"]),
        }
        for row in rows
    ]


async def cancel(env, order_id: str, actor: str, *, reason: str = "") -> bool:
    order = await get_order(env, order_id)
    if order is None or order["status"] not in HOLDING_STOCK:
        return False
    await env.DB.prepare(
        "UPDATE orders SET status = 'cancelled', cancelled_at = ?2, reserved_until = NULL, updated_at = ?2"
        " WHERE id = ?1"
    ).bind(order_id, utc_timestamp()).run()
    await release_stock(env, order_id)
    await audit(env, order_id, actor, "cancelled", before=order["status"], after="cancelled", detail=reason)
    await _tell_customer(env, order_id, "cancelled", detail=reason)
    return True


async def expire_unpaid(env) -> int:
    """Return stock from orders nobody finished paying for.

    Called on a schedule. Each order is settled one at a time so that a
    failure part-way leaves the rest still to be swept next time, rather than
    a batch that half happened.
    """

    now = utc_timestamp()
    rows = await d1_rows(
        env.DB.prepare("SELECT id FROM orders WHERE status = 'pending' AND reserved_until IS NOT NULL AND reserved_until < ?1").bind(now)
    )
    for row in rows:
        result = await (
            env.DB.prepare(
                "UPDATE orders SET status = 'expired', reserved_until = NULL, updated_at = ?2"
                " WHERE id = ?1 AND status = 'pending'"
            )
            .bind(row["id"], now)
            .run()
        )
        try:
            if int(result.meta.changes) != 1:
                continue
        except (AttributeError, TypeError, ValueError):
            continue
        await release_stock(env, row["id"])
        await audit(env, row["id"], "system", "expired", before="pending", after="expired")
        await _tell_customer(env, row["id"], "expired")
    return len(rows)


def validate_order_id(order_id: str) -> str:
    if not ORDER_ID_PATTERN.fullmatch(order_id):
        raise OrderError("訂單編號格式不正確")
    return order_id
