"""Customer profile, cart, checkout and order response handlers."""

import traceback

import auth_customer
from domain import cart, orders, shipping
import mail
from shared.common import d1_rows, env_var, taipei_day
from shared.responses import Ctx


async def cart_validate_response(ctx: Ctx):
    customer = await auth_customer.current_customer(ctx.env, ctx.request)
    if customer and customer.get("cartBlocked", customer.get("blocked", False)):
        return ctx.error("這個帳號目前無法使用購物車，請與我們聯絡。", 403)
    try:
        body = await ctx.request.json()
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        lines = cart.parse_lines(body.get("lines"))
    except cart.CartError as error:
        return ctx.error(str(error), 400)
    except (ValueError, AttributeError):
        return ctx.error("Invalid cart", 400)
    priced = await cart.price_lines(ctx.env, lines)
    if not priced["requiresShipping"]:
        # Nothing in this cart is posted. Offering delivery options would ask
        # the customer to pick between ways of sending them nothing.
        return ctx.json({**priced, "shipping": []})
    methods = await shipping.list_methods(ctx.env, only_enabled=True)
    # Quoted against what actually ships, so a course in the cart cannot push
    # the order over a free-delivery threshold it did not pay towards.
    return ctx.json({**priced, "shipping": shipping.quote(methods, priced["shippingSubtotal"])})


async def profile_response(ctx: Ctx, customer: dict):
    return ctx.json({"customer": customer})


async def update_profile_response(ctx: Ctx, customer: dict):
    try:
        body = await ctx.request.json()
        if not isinstance(body, dict):
            raise ValueError
        name = orders.validate_recipient_name(body.get("recipientName") or "")
        phone = orders.validate_phone(body.get("recipientPhone") or "")
        address = orders.validate_address(body.get("address") or "", required=False)
    except orders.OrderError as error:
        return ctx.error(str(error), 400)
    except (ValueError, AttributeError):
        return ctx.error("Invalid profile", 400)
    await auth_customer.update_profile(ctx.env, customer["id"], name=name, phone=phone, address=address)
    return ctx.json({"customer": await auth_customer.current_customer(ctx.env, ctx.request)})


async def checkout_response(ctx: Ctx, customer: dict):
    if customer.get("cartBlocked", customer.get("blocked", False)):
        return ctx.error("這個帳號目前無法下單，請與我們聯絡。", 403)
    try:
        body = await ctx.request.json()
        if not isinstance(body, dict):
            raise ValueError
        lines = cart.parse_lines(body.get("lines"))
        method_name = str(body.get("shippingMethod") or "")
        recipient = {"name": orders.validate_recipient_name(body.get("recipientName") or ""), "phone": orders.validate_phone(body.get("recipientPhone") or ""), "email": orders.validate_email(body.get("recipientEmail") or customer["email"]), "address": ""}
    except cart.CartError as error:
        return ctx.error(str(error), 400)
    except orders.OrderError as error:
        return ctx.error(str(error), 400)
    except (ValueError, AttributeError):
        return ctx.error("Invalid checkout", 400)
    method = await shipping.get_method(ctx.env, method_name)
    if method is None or not method["enabled"]:
        return ctx.error("請選擇一個可用的配送方式", 400)
    if method["method"] == "home":
        try:
            recipient["address"] = orders.validate_address(body.get("address") or "", required=True)
        except orders.OrderError as error:
            return ctx.error(str(error), 400)
    priced = await cart.price_lines(ctx.env, lines)
    if priced["problems"]:
        return ctx.json({"error": "購物車內容已經變動，請回到購物車確認後再結帳", "problems": priced["problems"]}, 409)
    try:
        order = await orders.create_order(ctx.env, customer, priced=priced, method=method, recipient=recipient, day=taipei_day().replace("-", ""))
    except orders.OrderError as error:
        return ctx.error(str(error), 409)
    # A successful checkout becomes the next checkout's defaults. A store
    # pickup has no delivery address, so it must not erase a saved home one.
    try:
        await auth_customer.update_profile(
            ctx.env,
            customer["id"],
            name=recipient["name"],
            phone=recipient["phone"],
            address=recipient["address"] or customer["address"],
        )
    except Exception:
        traceback.print_exc()
    items = await orders.list_items(ctx.env, order["id"])
    try:
        await mail.queue_order_event(ctx.env, "created", order, items)
        await mail.queue_owner_alert(ctx.env, order, items)
    except Exception:
        traceback.print_exc()
    return ctx.json({"order": order, "items": items}, 201)


async def order_response(ctx: Ctx, customer: dict, order_id: str):
    try:
        order_id = orders.validate_order_id(order_id)
    except orders.OrderError as error:
        return ctx.error(str(error), 400)
    rows = await d1_rows(ctx.env.DB.prepare("SELECT * FROM orders WHERE id = ?1 AND customer_id = ?2").bind(order_id, customer["id"]))
    if not rows:
        return ctx.error("Order not found", 404)
    order = orders.order_row(rows[0])
    return ctx.json({"order": order, "items": await orders.list_card_items(ctx.env, order_id)})


async def fake_payment_response(ctx: Ctx, customer: dict, order_id: str):
    if env_var(ctx.env, "ALLOW_FAKE_PAYMENT") != "1":
        return ctx.error("Unknown endpoint", 404)
    try:
        order_id = orders.validate_order_id(order_id)
    except orders.OrderError as error:
        return ctx.error(str(error), 400)
    order = await orders.get_order(ctx.env, order_id)
    if order is None or order.get("customerId") != customer["id"]:
        return ctx.error("Order not found", 404)
    if not await orders.mark_paid(ctx.env, order_id, f"fake-payment:{customer['id']}", detail="no gateway involved"):
        return ctx.error("這筆訂單不在等待付款的狀態", 409)
    return ctx.json({"order": await orders.get_order(ctx.env, order_id)})
