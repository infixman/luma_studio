"""The member list, from the shop's side.

`admin_main.dispatch` has already established that the caller is signed in.

Two of the three actions are consequential: blocking someone's checkout, and
erasing them. Both answer with the customer as they now are, so the back
office never has to guess whether the click landed.
"""

from domain import customer_activity, customers, entitlements, orders
from shared import paging
from shared.responses import Ctx


async def _detail(ctx: Ctx, customer_id: str) -> dict:
    customer = await customers.get(ctx.env, customer_id)
    if customer is None:
        return {}
    return {
        "customer": customer,
        "orders": await orders.list_for_customer(ctx.env, customer_id),
        "activity": await customer_activity.recent(ctx.env, customer_id),
        "stats": await customer_activity.summary(ctx.env, customer_id),
    }


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
    # Split once: an action can itself contain a slash (`entitlements/gift`),
    # and treating that as an action plus a tail would route it nowhere.
    customer_id, _, action = rest.partition("/")
    try:
        customer_id = customers.validate_customer_id(customer_id)
    except ValueError:
        return ctx.error("Invalid customer id", 400)

    if not action and method == "GET":
        detail = await _detail(ctx, customer_id)
        return ctx.json(detail) if detail else ctx.error("Customer not found", 404)

    if action == "entitlements" and method == "GET":
        return ctx.json({"entitlements": await entitlements.list_for_customer(env, customer_id)})

    if method != "POST":
        return ctx.error("Not found", 404)

    if action == "entitlements/gift":
        # A gift with no reason is a grant nobody can account for, and
        # therefore one nobody can undo with confidence later.
        try:
            body = await ctx.json_body()
            await entitlements.grant_as_gift(
                env,
                customer_id=customer_id,
                course_id=str(body.get("courseId") or ""),
                actor=ctx.admin_email,
                reason=str(body.get("reason") or "").strip(),
            )
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid gift", 400)
        return ctx.json({"granted": True}, 201)

    if action == "blocked":
        try:
            blocked = bool((await ctx.json_body()).get("blocked"))
        except (ValueError, AttributeError):
            return ctx.error("Invalid request", 400)
        if not await customers.set_blocked(env, customer_id, blocked):
            return ctx.error("Customer not found", 404)
        return ctx.json(await _detail(ctx, customer_id))

    if action == "account-blocked":
        try:
            blocked = bool((await ctx.json_body()).get("blocked"))
        except (ValueError, AttributeError):
            return ctx.error("Invalid request", 400)
        if not await customers.set_account_blocked(env, customer_id, blocked):
            return ctx.error("Customer not found", 404)
        return ctx.json(await _detail(ctx, customer_id))

    if action == "profile":
        try:
            body = await ctx.json_body()
            display_name = str(body.get("displayName") or "")
            raw_name = str(body.get("recipientName") or "").strip()
            raw_phone = str(body.get("recipientPhone") or "").strip()
            recipient_name = orders.validate_recipient_name(raw_name) if raw_name else ""
            recipient_phone = orders.validate_phone(raw_phone) if raw_phone else ""
            address = orders.validate_address(body.get("address") or "", required=False)
        except orders.OrderError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid profile", 400)
        if not await customers.update_profile(
            env,
            customer_id,
            display_name=display_name,
            recipient_name=recipient_name,
            recipient_phone=recipient_phone,
            address=address,
        ):
            return ctx.error("Customer not found or already anonymised", 404)
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
