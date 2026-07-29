"""Orders, from the shop's side.

`admin_main.dispatch` has already established that the caller is signed in,
and this deployment has exactly one signed-in person, so every action here is
recorded against their email rather than against "admin". The day a payment is
disputed, "who marked this paid" needs a name in it.

Two things are refused rather than allowed on principle: an order cannot move
backwards, and it cannot skip `paid`. Those rules live in `orders.FORWARD`,
not here — this file is the door, not the policy.
"""

import mail
import orders
import paging
from responses import Ctx


MAX_NOTE = 500
MAX_REASON = 200

# Far enough out that no real order falls outside it, close enough that a
# mistyped year cannot turn into a number SQLite has to think about.
MIN_TIME = 0
MAX_TIME = 4102444800  # 2100-01-01


def _first(ctx: Ctx, name: str) -> str:
    return (ctx.query.get(name) or [""])[0].strip()


def _seconds(ctx: Ctx, name: str) -> int | None:
    """A `created_at` bound, or None when it was not asked for.

    The back office sends seconds rather than a date, because the day a filter
    means is the day in the reader's timezone and the server has no way to
    know which one that is. Anything unparseable is treated as "no bound"
    rather than as zero — a filter that silently became "everything since the
    epoch" would look like it worked.
    """

    raw = _first(ctx, name)
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if MIN_TIME <= value <= MAX_TIME else None


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
        "emails": await mail.list_for_order(ctx.env, order_id),
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/orders" and method == "GET":
        # Both are repeatable. "不是已取消" and "不是已逾期" is a pair anybody
        # might stack; two "是" cannot both hold, and that is exactly why they
        # are read rather than collapsed. Silently keeping the last one would
        # drop a rule the filter bar is still showing with 而且 beside it —
        # the answer to an impossible filter is no rows, not a different
        # filter's rows.
        wanted = tuple(dict.fromkeys(value.strip() for value in ctx.query.get("status", []) if value.strip()))
        excluded = tuple(value.strip() for value in ctx.query.get("statusNot", []) if value.strip())
        for value in (*wanted, *excluded):
            if value and value not in orders.STATUSES:
                return ctx.error(f"狀態必須是 {'、'.join(orders.STATUSES)} 其中之一", 400)
        search = _first(ctx, "q")[:60]
        page, per_page = paging.clamp(_first(ctx, "page"), _first(ctx, "perPage"))
        rows, total = await orders.list_all(
            env,
            statuses=wanted,
            exclude_statuses=excluded,
            search=search,
            created_from=_seconds(ctx, "createdFrom"),
            created_to=_seconds(ctx, "createdTo"),
            page=page,
            per_page=per_page,
        )
        return ctx.json(
            {
                "orders": rows,
                # The counts come back with every list so the tabs can show
                # them without a second request that could disagree.
                "counts": await orders.counts_by_status(env),
                **paging.envelope(rows, total, page, per_page),
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
            detail = str((await ctx.json_body()).get("detail") or "").strip()[:MAX_NOTE]
        except (ValueError, AttributeError):
            detail = ""
        if not await orders.mark_paid(env, order_id, _actor(ctx), detail=detail or "manually marked paid"):
            return ctx.error("這筆訂單不是待付款狀態", 409)
        return ctx.json(await _detail(ctx, order_id))

    if action in ("shipped", "completed"):
        try:
            note = str((await ctx.json_body()).get("detail") or "").strip()[:MAX_NOTE]
        except (ValueError, AttributeError):
            note = ""
        if await orders.advance(env, order_id, action, _actor(ctx), detail=note) is None:
            return ctx.error("這筆訂單目前的狀態不能做這個動作", 409)
        return ctx.json(await _detail(ctx, order_id))

    if action == "cancel":
        try:
            reason = str((await ctx.json_body()).get("reason") or "").strip()[:MAX_REASON]
        except (ValueError, AttributeError):
            reason = ""
        # Cancelling puts the stock back, including for an order already
        # marked shipped — that case is a return, and the goods come back.
        if not await orders.cancel(env, order_id, _actor(ctx), reason=reason):
            return ctx.error("這筆訂單已經不能取消了", 409)
        return ctx.json(await _detail(ctx, order_id))

    if action == "note":
        try:
            note = str((await ctx.json_body()).get("note") or "").strip()[:MAX_NOTE]
        except (ValueError, AttributeError):
            return ctx.error("Invalid note", 400)
        if not await orders.set_note(env, order_id, note, _actor(ctx)):
            return ctx.error("Order not found", 404)
        return ctx.json(await _detail(ctx, order_id))

    return ctx.error("Not found", 404)
