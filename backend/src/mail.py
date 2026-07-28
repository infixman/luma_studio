"""Telling people what happened to their order.

Mail is queued where the decision is made and sent somewhere else. Three
reasons, all of them structural:

* The admin Worker can mark an order shipped, and it has no schedule of its
  own. Writing a row is something both deployments can do; talking to a mail
  provider on a cron is not.
* A customer's order must not fail because a third party was slow. Checkout
  writes a row and moves on.
* A queue that survives is a queue that can be retried, and a record of what
  was actually sent. "Did they get the shipping notice" is a question that
  gets asked.

Everything here is a no-op when the shop has not been configured to send
mail. Nothing is queued in that case either: a month of undelivered rows that
all go out the moment a key is added would tell customers their order shipped
in April.
"""

import json

from common import d1_rows, env_var, js_options, urlsafe_token, utc_timestamp
from js import fetch as js_fetch


SEND_URL = "https://api.resend.com/emails"

MAX_ATTEMPTS = 5
MAX_PER_RUN = 20
MAX_BODY = 8000

STATUS_PENDING = "pending"
STATUS_SENT = "sent"
STATUS_FAILED = "failed"


def configured(env) -> bool:
    """Whether this deployment can send at all.

    The from-address is the flag. A key with no address cannot produce a valid
    message, and an address with no key cannot deliver one, so both being
    present is the only state worth calling "on".
    """

    return bool(env_var(env, "MAIL_FROM")) and bool(env_var(env, "RESEND_API_KEY"))


def _money(amount: int) -> str:
    return f"NT${int(amount)}"


def _lines(order: dict, items: list[dict]) -> str:
    rows = [f"・{item['productTitle']} {item['variantTitle']} × {item['quantity']}　{_money(item['subtotal'])}" for item in items]
    rows.append(f"　運費　{_money(order['shippingFee'])}")
    rows.append(f"　合計　{_money(order['total'])}")
    return "\n".join(rows)


def _delivery(order: dict) -> str:
    if order.get("storeName"):
        return f"取貨門市：{order['storeName']}"
    return f"寄送地址：{order.get('shippingAddress') or '—'}"


def compose(kind: str, order: dict, items: list[dict], *, detail: str = "") -> tuple[str, str] | None:
    """The subject and body for one event, or None if that event is not one
    customers hear about.

    Plain text on purpose. A receipt that renders the same in every client
    beats one that looks designed in two of them.
    """

    number = order["id"]
    greeting = f"{order['recipientName']} 您好，"
    footer = "\n\n苒光繪誌\nhttps://luma-studio.tw"

    if kind == "created":
        return (
            f"[苒光繪誌] 訂單成立 {number}",
            f"{greeting}\n\n我們收到您的訂單了。\n\n"
            f"訂單編號：{number}\n{_lines(order, items)}\n{_delivery(order)}\n\n"
            "付款完成後我們會再寄一封通知信給您。" + footer,
        )

    if kind == "paid":
        return (
            f"[苒光繪誌] 已收到款項 {number}",
            f"{greeting}\n\n我們已經收到 {number} 的款項 {_money(order['total'])}。\n\n"
            "商品備妥出貨後會再通知您。" + footer,
        )

    if kind == "shipped":
        extra = f"\n\n{detail}" if detail else ""
        return (
            f"[苒光繪誌] 已出貨 {number}",
            f"{greeting}\n\n{number} 已經出貨。\n\n{_delivery(order)}{extra}" + footer,
        )

    if kind == "cancelled":
        reason = f"\n\n原因：{detail}" if detail else ""
        return (
            f"[苒光繪誌] 訂單已取消 {number}",
            f"{greeting}\n\n{number} 已經取消。{reason}\n\n"
            "若您已經付款，我們會與您聯絡退款事宜。" + footer,
        )

    if kind == "expired":
        return (
            f"[苒光繪誌] 訂單已逾期 {number}",
            f"{greeting}\n\n{number} 因為超過付款期限已經取消，保留的商品已經放回。\n\n"
            "還想要的話，重新下單就可以了。" + footer,
        )

    # `completed` deliberately sends nothing. "Your order is complete" arrives
    # after the parcel did, and says less than the parcel.
    return None


def owner_alert(order: dict, items: list[dict]) -> tuple[str, str]:
    return (
        f"[苒光繪誌] 新訂單 {order['id']}　{_money(order['total'])}",
        f"{order['recipientName']}　{order['recipientPhone']}\n{order['recipientEmail']}\n\n"
        f"{_lines(order, items)}\n{_delivery(order)}\n\n"
        f"https://admin.luma-studio.tw/orders?q={order['id']}",
    )


# --- the queue -----------------------------------------------------------


async def queue(env, *, kind: str, recipient: str, subject: str, body: str, order_id: str | None = None) -> bool:
    """Write one message to be sent later. False when mail is switched off."""

    if not configured(env) or not recipient:
        return False
    await env.DB.prepare(
        """INSERT INTO email_outbox (id, order_id, kind, recipient, subject, body, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)"""
    ).bind(urlsafe_token(12), order_id, kind, recipient, subject[:200], body[:MAX_BODY], utc_timestamp()).run()
    return True


async def queue_order_event(env, kind: str, order: dict, items: list[dict], *, detail: str = "") -> None:
    """Queue whatever a customer should hear about this change, if anything."""

    message = compose(kind, order, items, detail=detail)
    if message is None:
        return
    subject, body = message
    await queue(env, kind=kind, recipient=order["recipientEmail"], subject=subject, body=body, order_id=order["id"])


async def queue_owner_alert(env, order: dict, items: list[dict]) -> None:
    owner = env_var(env, "MAIL_OWNER")
    if not owner:
        return
    subject, body = owner_alert(order, items)
    await queue(env, kind="owner", recipient=owner, subject=subject, body=body, order_id=order["id"])


async def list_for_order(env, order_id: str) -> list[dict]:
    """What was queued for one order, and whether it went.

    Shown in the back office because "did they get the shipping notice" is a
    question that gets asked, and the answer should not require a database
    console.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM email_outbox WHERE order_id = ?1 ORDER BY created_at, id"
        ).bind(order_id)
    )
    return [
        {
            "kind": row["kind"],
            "recipient": row["recipient"],
            "subject": row["subject"],
            "status": row["status"],
            "attempts": int(row["attempts"]),
            "lastError": row["last_error"],
            "createdAt": int(row["created_at"]),
            "sentAt": int(row["sent_at"]) if row["sent_at"] is not None else None,
        }
        for row in rows
    ]


# --- sending -------------------------------------------------------------


async def _post(env, message: dict) -> tuple[bool, str]:
    """One request to the provider.

    Everything provider-shaped is in this function. Swapping Resend for
    another service is this body and the two settings it reads.
    """

    payload = {
        "from": env_var(env, "MAIL_FROM"),
        "to": [message["recipient"]],
        "subject": message["subject"],
        "text": message["body"],
    }
    options = {
        "method": "POST",
        "headers": {
            "authorization": f"Bearer {env_var(env, 'RESEND_API_KEY')}",
            "content-type": "application/json",
        },
        "body": json.dumps(payload),
    }
    try:
        response = await js_fetch(SEND_URL, js_options(options))
    except Exception as error:  # network, DNS, timeout
        return False, str(error)[:200]

    if response.ok:
        return True, ""
    try:
        text = str(await response.text())[:200]
    except Exception:
        text = ""
    return False, f"{response.status} {text}"


async def send_pending(env, limit: int = MAX_PER_RUN) -> dict:
    """Drain the outbox. Returns what happened, for the caller to log.

    Each message is settled on its own. A provider outage marks attempts and
    leaves the row for the next run; five failures give up, because a mailbox
    that does not exist will not start existing.
    """

    if not configured(env):
        return {"sent": 0, "failed": 0, "skipped": True}

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM email_outbox WHERE status = 'pending' ORDER BY created_at, id LIMIT ?1"
        ).bind(max(1, min(limit, MAX_PER_RUN)))
    )

    sent = failed = 0
    for row in rows:
        ok, error = await _post(env, row)
        attempts = int(row["attempts"]) + 1
        if ok:
            sent += 1
            await env.DB.prepare(
                "UPDATE email_outbox SET status = 'sent', attempts = ?2, sent_at = ?3 WHERE id = ?1"
            ).bind(row["id"], attempts, utc_timestamp()).run()
        else:
            failed += 1
            status = STATUS_FAILED if attempts >= MAX_ATTEMPTS else STATUS_PENDING
            await env.DB.prepare(
                "UPDATE email_outbox SET status = ?2, attempts = ?3, last_error = ?4 WHERE id = ?1"
            ).bind(row["id"], status, attempts, error[:200]).run()
    return {"sent": sent, "failed": failed, "skipped": False}
