"""Orders, from the shop's side.

`admin_main.dispatch` has already established that the caller is signed in,
and this deployment has exactly one signed-in person, so every action here is
recorded against their email rather than against "admin". The day a payment is
disputed, "who marked this paid" needs a name in it.

Two things are refused rather than allowed on principle: an order cannot move
backwards, and it cannot skip `paid`. Those rules live in `orders.FORWARD`,
not here — this file is the door, not the policy.
"""

import orders
from responses import Ctx


MAX_NOTE = 500
MAX_REASON = 200


async def _read_json(ctx: Ctx) -> dict:
    body = await ctx.request.json()
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    return body


def _actor(ctx: Ctx) -> str:
    """Who is doing this. Falls back to the deployment, never to nobody."""

    email = getattr(ctx, "admin_email", "") or ""
    return str(email) or "admin"


async def _detail(ctx: Ctx, order_id: str) -> dict:
    order = await orders.get_order_for_admin(ctx.env, order_id)
    if order is None:
        return {}
    return {
        "order": order,
        "items": await orders.list_items(ctx.env, order_id),
        "attempts": await orders.list_attempts(ctx.env, order_id),
        "audit": await orders.list_audit(ctx.env, order_id),
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/orders" and method == "GET":
        status = (ctx.query.get("status") or [""])[0]
        if status and status not in orders.STATUSES:
            return ctx.error(f"狀態必須是 {'、'.join(orders.STATUSES)} 其中之一", 400)
        search = (ctx.query.get("q") or [""])[0].strip()[:60]
        return ctx.json(
            {
                "orders": await orders.list_all(env, status=status, search=search),
                # The counts come back with every list so the tabs can show
                # them without a second request that could disagree.
                "counts": await orders.counts_by_status(env),
            }
        )

    if not path.startswith("/api/orders/"):
        return ctx.error("Not found", 404)

    rest = path.removeprefix("/api/orders/")
    order_id, _, action = rest.partition("/")
    try:
        order_id = orders.validate_order_id(order_id)
    except orders.OrderError:
        return ctx.error("Invalid order id", 400)

    if not action and method == "GET":
        detail = await _detail(ctx, order_id)
        return ctx.json(detail) if detail else ctx.error("Order not found", 404)

    if method != "POST":
        return ctx.error("Not found", 404)

    if action == "paid":
        # For a bank transfer that arrived before any gateway exists. The
        # reference goes in the audit detail, because "marked paid by hand" is
        # only useful next to what it was matched against.
        try:
            detail = str((await _read_json(ctx)).get("detail") or "").strip()[:MAX_NOTE]
        except (ValueError, AttributeError):
            detail = ""
        if not await orders.mark_paid(env, order_id, _actor(ctx), detail=detail or "manually marked paid"):
            return ctx.error("這筆訂單不是待付款狀態", 409)
        return ctx.json(await _detail(ctx, order_id))

    if action in ("shipped", "completed"):
        try:
            note = str((await _read_json(ctx)).get("detail") or "").strip()[:MAX_NOTE]
        except (ValueError, AttributeError):
            note = ""
        if await orders.advance(env, order_id, action, _actor(ctx), detail=note) is None:
            return ctx.error("這筆訂單目前的狀態不能做這個動作", 409)
        return ctx.json(await _detail(ctx, order_id))

    if action == "cancel":
        try:
            reason = str((await _read_json(ctx)).get("reason") or "").strip()[:MAX_REASON]
        except (ValueError, AttributeError):
            reason = ""
        # Cancelling puts the stock back, including for an order already
        # marked shipped — that case is a return, and the goods come back.
        if not await orders.cancel(env, order_id, _actor(ctx), reason=reason):
            return ctx.error("這筆訂單已經不能取消了", 409)
        return ctx.json(await _detail(ctx, order_id))

    if action == "note":
        try:
            note = str((await _read_json(ctx)).get("note") or "").strip()[:MAX_NOTE]
        except (ValueError, AttributeError):
            return ctx.error("Invalid note", 400)
        if not await orders.set_note(env, order_id, note, _actor(ctx)):
            return ctx.error("Order not found", 404)
        return ctx.json(await _detail(ctx, order_id))

    return ctx.error("Not found", 404)
