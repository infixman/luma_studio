"""The member list, from the shop's side.

`admin_main.dispatch` has already established that the caller is signed in.

Two of the three actions are consequential: blocking someone's checkout, and
erasing them. Both answer with the customer as they now are, so the back
office never has to guess whether the click landed.
"""

from domain import customers, orders
import paging
from responses import Ctx


async def _detail(ctx: Ctx, customer_id: str) -> dict:
    customer = await customers.get(ctx.env, customer_id)
    if customer is None:
        return {}
    return {"customer": customer, "orders": await orders.list_for_customer(ctx.env, customer_id)}


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/customers" and method == "GET":
        search = (ctx.query.get("q") or [""])[0].strip()
        page, per_page = paging.clamp(
            (ctx.query.get("page") or [""])[0], (ctx.query.get("perPage") or [""])[0]
        )
        rows, total = await customers.list_all(env, search=search, page=page, per_page=per_page)
        return ctx.json({"customers": rows, **paging.envelope(rows, total, page, per_page)})

    if not path.startswith("/api/customers/"):
        return ctx.error("Not found", 404)

    rest = path.removeprefix("/api/customers/")
    customer_id, _, action = rest.partition("/")
    try:
        customer_id = customers.validate_customer_id(customer_id)
    except ValueError:
        return ctx.error("Invalid customer id", 400)

    if not action and method == "GET":
        detail = await _detail(ctx, customer_id)
        return ctx.json(detail) if detail else ctx.error("Customer not found", 404)

    if method != "POST":
        return ctx.error("Not found", 404)

    if action == "blocked":
        try:
            blocked = bool((await ctx.json_body()).get("blocked"))
        except (ValueError, AttributeError):
            return ctx.error("Invalid request", 400)
        if not await customers.set_blocked(env, customer_id, blocked):
            return ctx.error("Customer not found", 404)
        return ctx.json(await _detail(ctx, customer_id))

    if action == "notes":
        try:
            notes = str((await ctx.json_body()).get("notes") or "")
        except (ValueError, AttributeError):
            return ctx.error("Invalid request", 400)
        if not await customers.set_notes(env, customer_id, notes):
            return ctx.error("Customer not found", 404)
        return ctx.json(await _detail(ctx, customer_id))

    if action == "anonymise":
        # Erasing keeps the row and the orders. Only the profile goes.
        if not await customers.anonymise(env, customer_id):
            return ctx.error("這個帳號不存在，或已經清除過了", 409)
        return ctx.json(await _detail(ctx, customer_id))

    return ctx.error("Not found", 404)
