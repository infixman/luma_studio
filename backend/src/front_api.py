"""HTTP response handlers for the public Worker.

`main.dispatch` owns route selection and authorization boundaries.  This
module owns converting an already-matched public request into a response.
Keeping the two separate makes the Worker entrypoint small without letting
HTTP concerns leak into the domain modules.
"""

from urllib.parse import unquote
import traceback

import workers

import auth_customer
from domain import bio_link, block_data, cart, categories, media, orders, pages, shipping, shop, site_chrome
import mail
from shared.common import (
    CACHE_1D,
    CACHE_1H,
    IMAGE_CONTENT_TYPES,
    IbonError,
    OAuthError,
    d1_rows,
    env_var,
    taipei_day,
    validate_file_name,
    validate_folder,
)
from ibon import resolve_print_result
from shared.responses import Ctx, frontend_origin, serve_r2_image


def wants_json(ctx: Ctx) -> bool:
    """Decide whether a legacy /ibon_print/{id} caller wants data or a page."""

    requested = (ctx.query.get("format") or [""])[0].lower()
    if requested == "json":
        return True
    if requested == "html":
        return False
    accept = ctx.request.headers.get("Accept") or ""
    return "application/json" in accept and "text/html" not in accept


async def public_image_response(ctx: Ctx, path: str):
    """Serve one validated R2 image through the intentionally public image URL."""

    _, _, folder, file_name = path.split("/", 3)
    try:
        folder = validate_folder(unquote(folder))
        file_name = validate_file_name(unquote(file_name))
    except ValueError:
        return ctx.error("Invalid image URL", 400)

    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, f"{folder}/{file_name}", IMAGE_CONTENT_TYPES, CACHE_1H)


async def bio_link_response(ctx: Ctx):
    """The public bio link page's content, plus one view event per visitor."""

    settings = await bio_link.get_settings(ctx.env)
    items = await bio_link.list_items(ctx.env, only_enabled=True)
    record = bio_link.record_event(ctx.env, ctx.request, "view")
    try:
        workers.wait_until(record)
    except Exception:
        await record

    return ctx.json(
        {
            "displayName": settings["displayName"],
            "bio": settings["bio"],
            "avatarPath": settings["avatarPath"],
            "style": {
                "theme": settings["theme"],
                "buttonShape": settings["buttonShape"],
                "fontStyle": settings["fontStyle"],
            },
            "hasCalendar": bool(settings["calendarEnabled"] and settings["calendarUrl"]),
            "links": [{"id": item["id"], "title": item["title"]} for item in items if item["kind"] == "link"],
            "socials": [
                {"id": item["id"], "title": item["title"], "platform": item["platform"]}
                for item in items
                if item["kind"] == "social"
            ],
        }
    )


async def bio_link_calendar_response(ctx: Ctx):
    settings = await bio_link.get_settings(ctx.env)
    return ctx.json({"calendar": await bio_link.fetch_calendar(ctx.env, settings)})


async def bio_link_redirect_response(ctx: Ctx, item_id: str):
    try:
        item_id = bio_link.validate_item_id(unquote(item_id))
    except ValueError:
        return ctx.error("Link not found", 404)

    item = await bio_link.get_item(ctx.env, item_id)
    if not item or not item["enabled"]:
        return ctx.error("Link not found", 404)
    try:
        destination = bio_link.validate_url(item["url"])
    except ValueError:
        return ctx.error("This link is no longer valid", 409)

    await bio_link.record_event(ctx.env, ctx.request, "click", item_id)
    return ctx.redirect(destination)


async def bio_link_avatar_response(ctx: Ctx, file_name: str):
    file_name = unquote(file_name)
    suffix = file_name[file_name.rfind(".") :].lower()
    if "/" in file_name or ".." in file_name or suffix not in bio_link.AVATAR_SUFFIXES:
        return ctx.error("Invalid avatar URL", 400)
    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, f"{bio_link.AVATAR_PREFIX}/{file_name}", IMAGE_CONTENT_TYPES, CACHE_1H)


async def shop_index_response(ctx: Ctx):
    products = await shop.list_products(ctx.env, only_active=True)
    cards = [
        shop.public_summary(product, await shop.list_variants(ctx.env, product["id"]), await shop.list_images(ctx.env, product["id"]))
        for product in products
    ]
    return ctx.json({"products": cards})


async def site_response(ctx: Ctx):
    env = ctx.env
    by_id = {page["id"]: page for page in await pages.list_pages(env, only_published=True)}
    slugs = {category["slug"] for category in await categories.list_all(env)}
    resolved = []
    for item in await site_chrome.list_menu(env):
        href = None
        if item["targetKind"] == "page":
            page = by_id.get(item["target"])
            if page is not None:
                href = "/" if page["isHome"] else page["path"]
        elif item["targetKind"] == "category":
            wanted = [part for part in item["target"].replace("+", ",").split(",") if part]
            if wanted and all(slug in slugs for slug in wanted):
                href = f"/shop/c/{item['target']}"
        else:
            href = item["target"]
        if href is not None:
            resolved.append({"id": item["id"], "parentId": item["parentId"], "label": item["label"], "href": href})
    return ctx.json({"settings": await site_chrome.get_settings(env), "menu": resolved})


async def page_response(ctx: Ctx, page: dict | None):
    if page is None or page["status"] != "published":
        return ctx.error("Page not found", 404)
    version = await pages.current_version(ctx.env, page["id"])
    if version is None:
        return ctx.error("Page not found", 404)
    return ctx.json(_page_payload(page, await block_data.hydrate(ctx.env, pages.blocks_of_snapshot(version["payload"]))))


async def preview_response(ctx: Ctx, token: str):
    page_id = await pages.redeem_preview_token(ctx.env, token)
    if page_id is None:
        return ctx.error("Preview link has expired", 404)
    page = await pages.get_page(ctx.env, page_id)
    if page is None:
        return ctx.error("Page not found", 404)
    return ctx.json(_page_payload(page, await block_data.hydrate(ctx.env, await pages.list_blocks(ctx.env, page_id))))


def _page_payload(page: dict, blocks: list) -> dict:
    return {
        "title": page["title"],
        "path": page["path"],
        "showHeader": page["showHeader"],
        "showFooter": page["showFooter"],
        "shareDescription": page["shareDescription"],
        "shareImagePath": page["shareImagePath"],
        "blocks": blocks,
    }


async def category_index_response(ctx: Ctx):
    counts = await categories.counts(ctx.env)
    return ctx.json({"categories": [
        {"slug": category["slug"], "title": category["title"], "productCount": counts.get(category["id"], 0)}
        for category in await categories.list_all(ctx.env)
    ]})


async def category_page_response(ctx: Ctx, raw: str):
    try:
        slugs, mode = categories.parse_filter(unquote(raw))
    except ValueError:
        return ctx.error("Category not found", 404)
    found = await categories.by_slugs(ctx.env, slugs)
    if len(found) != len(slugs):
        return ctx.error("Category not found", 404)
    products = await categories.products_in(ctx.env, [category["id"] for category in found], mode)
    cards = [
        shop.public_summary(product, await shop.list_variants(ctx.env, product["id"]), await shop.list_images(ctx.env, product["id"]))
        for product in products
    ]
    return ctx.json({
        "title": categories.filter_title(found, mode),
        "description": found[0]["description"] if len(found) == 1 else "",
        "mode": mode,
        "categories": [{"slug": category["slug"], "title": category["title"]} for category in found],
        "products": cards,
    })


async def shop_product_response(ctx: Ctx, slug: str):
    try:
        slug = shop.validate_slug(unquote(slug))
    except ValueError:
        return ctx.error("Product not found", 404)
    product = await shop.get_product_by_slug(ctx.env, slug)
    if product is None or product["status"] != "active":
        return ctx.error("Product not found", 404)
    return ctx.json(shop.public_detail(
        product,
        await shop.list_variants(ctx.env, product["id"]),
        await shop.list_images(ctx.env, product["id"]),
        await categories.of_product(ctx.env, product["id"]),
    ))


async def cart_validate_response(ctx: Ctx):
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
    methods = await shipping.list_methods(ctx.env, only_enabled=True)
    return ctx.json({**priced, "shipping": shipping.quote(methods, priced["subtotal"])})


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
    if customer["blocked"]:
        return ctx.error("這個帳號目前無法下單，請與我們聯絡。", 403)
    try:
        body = await ctx.request.json()
        if not isinstance(body, dict):
            raise ValueError
        lines = cart.parse_lines(body.get("lines"))
        method_name = str(body.get("shippingMethod") or "")
        recipient = {
            "name": orders.validate_recipient_name(body.get("recipientName") or ""),
            "phone": orders.validate_phone(body.get("recipientPhone") or ""),
            "email": orders.validate_email(body.get("recipientEmail") or customer["email"]),
            "address": "",
        }
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


async def media_image_response(ctx: Ctx, file_name: str):
    file_name = unquote(file_name)
    try:
        media.validate_image_suffix(file_name)
    except media.MediaError:
        return ctx.error("Invalid image URL", 400)
    key = f"{media.OBJECT_PREFIX}/{file_name}"
    if not await media.key_is_known(ctx.env, key):
        return ctx.error("Image not found", 404)
    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, key, IMAGE_CONTENT_TYPES, CACHE_1D)


async def site_image_response(ctx: Ctx, file_name: str):
    file_name = unquote(file_name)
    try:
        site_chrome.validate_image_suffix(file_name)
    except site_chrome.ChromeError:
        return ctx.error("Invalid image URL", 400)
    key = await site_chrome.header_image_key(ctx.env)
    if key != f"{site_chrome.IMAGE_PREFIX}/{file_name}":
        return ctx.error("Image not found", 404)
    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, key, IMAGE_CONTENT_TYPES, CACHE_1H)


async def shop_image_response(ctx: Ctx, file_name: str):
    file_name = unquote(file_name)
    try:
        shop.validate_image_suffix(file_name)
    except ValueError:
        return ctx.error("Invalid photo URL", 400)
    key = await shop.image_key_for_file(ctx.env, file_name)
    if key is None:
        return ctx.error("Photo not found", 404)
    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, key, IMAGE_CONTENT_TYPES, CACHE_1H)


async def print_response(ctx: Ctx, identifier: str):
    try:
        return ctx.json(await resolve_print_result(ctx.env, identifier))
    except ValueError as error:
        return ctx.error(str(error), 400)
    except IbonError as error:
        return ctx.json({"error": "Ibon upload failed", "stage": error.stage, "detail": error.detail}, 502)
    except Exception:
        return ctx.error("Unexpected Worker failure", 500)


def frontend_redirect(ctx: Ctx, path: str):
    origin = frontend_origin(ctx.env)
    if not origin:
        return ctx.error("Backend is missing FRONTEND_ORIGIN", 500)
    return ctx.redirect(f"{origin}{path}")
