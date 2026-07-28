"""Cloudflare Python Worker: the public JSON API.

This Worker renders no HTML. The browser interface is a separate deployment
that talks to these endpoints cross-origin.

Administration lives in `admin_main.py` on its own hostname, which is what
keeps the admin session cookie out of reach of anything served here. This
deployment also never applies a migration — see `router.serve`.

The /auth and /api/session routes below are the *customer's*. The back
office's live on the other host under the same names, and neither cookie is
ever sent to the other — see `auth_core.session_cookie`.
"""

from urllib.parse import unquote

import workers
from workers import WorkerEntrypoint

import auth_customer
import bio_link
import block_data
import cart
import categories
import orders
import pages
import rate_limit
import router
import shipping
import media
import shop
import site_chrome
from common import (
    IDENTIFIER_PATTERN,
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
from js import Uint8Array
from migrations import applied_migration_names
from responses import Ctx, frontend_origin


def wants_json(ctx: Ctx) -> bool:
    """Decide whether a legacy /ibon_print/{id} caller wants data or a page.

    These URLs are printed on shared links and QR codes, so anything that
    might be a person gets redirected to the page. In-app browsers and QR
    scanners often send `Accept: */*`, which is why the default is the page
    and only an explicit request for JSON opts out.
    """

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

    image = await ctx.env.IBON_IMAGES.get(f"{folder}/{file_name}")
    if image is None:
        return ctx.error("Image not found", 404)
    content = bytes(Uint8Array.new(await image.arrayBuffer()).to_py())
    suffix = file_name[file_name.rfind(".") :].lower()
    return ctx.binary(
        content,
        {
            "content-type": IMAGE_CONTENT_TYPES[suffix],
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
        },
    )


async def bio_link_response(ctx: Ctx):
    """The public bio link page's content, plus one view event per visitor.

    The schedule is not here: it costs a fetch to Google, and the page has
    nothing to show until this response arrives. It is a second request, so
    the links render without waiting for a calendar.
    """

    settings = await bio_link.get_settings(ctx.env)
    items = await bio_link.list_items(ctx.env, only_enabled=True)
    # Counting a visit must not delay showing them the page. Resolved here
    # rather than imported at module scope: if the runtime ever stops
    # offering it, this must fall back to a slower visit, not a Worker that
    # fails to start.
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
            # Anonymous visitors get only what the page renders.
            "links": [{"id": item["id"], "title": item["title"]} for item in items if item["kind"] == "link"],
            "socials": [
                {"id": item["id"], "title": item["title"], "platform": item["platform"]}
                for item in items
                if item["kind"] == "social"
            ],
        }
    )


async def bio_link_calendar_response(ctx: Ctx):
    """The schedule on its own, so the page does not wait for Google."""

    settings = await bio_link.get_settings(ctx.env)
    calendar = await bio_link.fetch_calendar(ctx.env, settings)
    return ctx.json({"calendar": calendar})


async def bio_link_redirect_response(ctx: Ctx, item_id: str):
    """Count the click, then send the visitor to the real destination."""

    try:
        item_id = bio_link.validate_item_id(unquote(item_id))
    except ValueError:
        return ctx.error("Link not found", 404)

    item = await bio_link.get_item(ctx.env, item_id)
    if not item or not item["enabled"]:
        return ctx.error("Link not found", 404)
    try:
        # The database is not a trust boundary: re-check before the URL
        # becomes a Location header, whatever validation applied on write.
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

    stored = await ctx.env.IBON_IMAGES.get(f"{bio_link.AVATAR_PREFIX}/{file_name}")
    if stored is None:
        return ctx.error("Avatar not found", 404)
    content = bytes(Uint8Array.new(await stored.arrayBuffer()).to_py())
    return ctx.binary(
        content,
        {
            "content-type": bio_link.AVATAR_CONTENT_TYPES[suffix],
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
        },
    )


async def shop_index_response(ctx: Ctx):
    """Every product a customer is allowed to see, as cards."""

    products = await shop.list_products(ctx.env, only_active=True)
    cards = []
    for product in products:
        cards.append(
            shop.public_summary(
                product,
                await shop.list_variants(ctx.env, product["id"]),
                await shop.list_images(ctx.env, product["id"]),
            )
        )
    return ctx.json({"products": cards})


async def site_response(ctx: Ctx):
    """The chrome every page wears, and the menu inside it.

    One endpoint rather than two: every page needs both, and splitting them
    only makes each page wait for an extra round trip.

    Menu targets are resolved here so the frontend never has to know how an
    id becomes a URL. An item pointing at a draft, a deleted page or a
    vanished category is left out entirely — a menu entry that leads to a 404
    is worse than a menu with one fewer entry.
    """

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
            # A combination like `a,b` is only offered when every part of it
            # still exists; half a filter would quietly change what it shows.
            wanted = [part for part in item["target"].replace("+", ",").split(",") if part]
            if wanted and all(slug in slugs for slug in wanted):
                href = f"/shop/c/{item['target']}"
        else:
            href = item["target"]

        if href is not None:
            resolved.append({"id": item["id"], "parentId": item["parentId"], "label": item["label"], "href": href})

    return ctx.json({"settings": await site_chrome.get_settings(env), "menu": resolved})


async def page_response(ctx: Ctx, page: dict | None):
    """One published page and its blocks.

    Drafts are 404 rather than gated: the back office previews them with the
    same components the storefront uses, so there is no reason for an
    unpublished page to be reachable here at all.
    """

    if page is None or page["status"] != "published":
        return ctx.error("Page not found", 404)
    return ctx.json(
        {
            "title": page["title"],
            "path": page["path"],
            # The site's chrome is on unless this page opted out of it.
            "showHeader": page["showHeader"],
            "showFooter": page["showFooter"],
            "blocks": await block_data.hydrate(ctx.env, await pages.list_blocks(ctx.env, page["id"])),
        }
    )


async def category_index_response(ctx: Ctx):
    """Every category, with how many active products each one holds."""

    counts = await categories.counts(ctx.env)
    return ctx.json(
        {
            "categories": [
                {
                    "slug": category["slug"],
                    "title": category["title"],
                    "productCount": counts.get(category["id"], 0),
                }
                for category in await categories.list_all(ctx.env)
            ]
        }
    )


async def category_page_response(ctx: Ctx, raw: str):
    """One category, or a combination of them.

    `a,b` is either, `a+b` is both. A URL naming an unknown slug is a 404;
    one naming a real but empty category is not — the owner may be about to
    put something in it, and 404 would read as a broken category.
    """

    try:
        slugs, mode = categories.parse_filter(unquote(raw))
    except ValueError:
        return ctx.error("Category not found", 404)

    found = await categories.by_slugs(ctx.env, slugs)
    if len(found) != len(slugs):
        return ctx.error("Category not found", 404)

    products = await categories.products_in(ctx.env, [category["id"] for category in found], mode)
    cards = []
    for product in products:
        cards.append(
            shop.public_summary(
                product,
                await shop.list_variants(ctx.env, product["id"]),
                await shop.list_images(ctx.env, product["id"]),
            )
        )

    return ctx.json(
        {
            "title": categories.filter_title(found, mode),
            # Only a single category has a description of its own; no one
            # category's blurb describes a combination.
            "description": found[0]["description"] if len(found) == 1 else "",
            "mode": mode,
            "categories": [{"slug": category["slug"], "title": category["title"]} for category in found],
            "products": cards,
        }
    )


async def shop_product_response(ctx: Ctx, slug: str):
    """One product page, addressed by the slug rather than the id.

    Only `active` products resolve. A draft is reachable by anyone who guesses
    its slug otherwise, and an archived one would keep selling after it was
    meant to stop.
    """

    try:
        slug = shop.validate_slug(unquote(slug))
    except ValueError:
        return ctx.error("Product not found", 404)

    product = await shop.get_product_by_slug(ctx.env, slug)
    if product is None or product["status"] != "active":
        return ctx.error("Product not found", 404)

    return ctx.json(
        shop.public_detail(
            product,
            await shop.list_variants(ctx.env, product["id"]),
            await shop.list_images(ctx.env, product["id"]),
            await categories.of_product(ctx.env, product["id"]),
        )
    )


async def cart_validate_response(ctx: Ctx):
    """Recompute a browser's cart from the database and price it.

    Everything the client sent is treated as a request rather than a fact.
    The delivery quotes come back with it so the cart page can show a total
    without a second round trip.
    """

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
    """Turn a validated cart into an order, holding its stock.

    The cart is repriced here rather than trusted, using the very same
    function the cart page called. Whatever a customer was shown and whatever
    they are charged come out of one piece of code, so the two cannot drift.
    """

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
        # Sending them back to the cart is deliberate: the alternative is
        # charging for something other than what they agreed to.
        return ctx.json(
            {"error": "購物車內容已經變動，請回到購物車確認後再結帳", "problems": priced["problems"]}, 409
        )

    try:
        order = await orders.create_order(
            ctx.env, customer, priced=priced, method=method, recipient=recipient, day=taipei_day().replace("-", "")
        )
    except orders.OrderError as error:
        return ctx.error(str(error), 409)

    return ctx.json({"order": order, "items": await orders.list_items(ctx.env, order["id"])}, 201)


async def order_response(ctx: Ctx, customer: dict, order_id: str):
    try:
        order_id = orders.validate_order_id(order_id)
    except orders.OrderError as error:
        return ctx.error(str(error), 400)

    # Scoped to the caller: an order id is short enough to guess at, and
    # somebody else's delivery address is not ours to hand out.
    rows = await d1_rows(
        ctx.env.DB.prepare("SELECT * FROM orders WHERE id = ?1 AND customer_id = ?2").bind(order_id, customer["id"])
    )
    if not rows:
        return ctx.error("Order not found", 404)

    order = orders.order_row(rows[0])
    return ctx.json({"order": order, "items": await orders.list_items(ctx.env, order_id)})


async def fake_payment_response(ctx: Ctx, customer: dict, order_id: str):
    """Mark an order paid without a gateway. Development only.

    PAYUNi is not wired up yet, and the rest of the flow — stock, statuses,
    the audit trail — needs exercising before it is. This exists to do that
    and nothing else, so it answers 404 unless a deployment has explicitly
    switched it on. The default is off, and production never sets it.
    """

    if env_var(ctx.env, "ALLOW_FAKE_PAYMENT") != "1":
        return ctx.error("Unknown endpoint", 404)

    try:
        order_id = orders.validate_order_id(order_id)
    except orders.OrderError as error:
        return ctx.error(str(error), 400)

    order = await orders.get_order(ctx.env, order_id)
    if order is None:
        return ctx.error("Order not found", 404)

    if not await orders.mark_paid(ctx.env, order_id, f"fake-payment:{customer['id']}", detail="no gateway involved"):
        return ctx.error("這筆訂單不在等待付款的狀態", 409)
    return ctx.json({"order": await orders.get_order(ctx.env, order_id)})


async def media_image_response(ctx: Ctx, file_name: str):
    """Serve one image from the media library.

    The key has to be one the library knows about. Reading whatever the URL
    names would turn this route into a way to fetch any object in a bucket
    that also holds ibon print jobs.
    """

    file_name = unquote(file_name)
    try:
        media.validate_image_suffix(file_name)
    except media.MediaError:
        return ctx.error("Invalid image URL", 400)

    key = f"{media.OBJECT_PREFIX}/{file_name}"
    if not await media.key_is_known(ctx.env, key):
        return ctx.error("Image not found", 404)
    stored = await ctx.env.IBON_IMAGES.get(key)
    if stored is None:
        return ctx.error("Image not found", 404)
    content = bytes(Uint8Array.new(await stored.arrayBuffer()).to_py())
    return ctx.binary(
        content,
        {
            "content-type": media.content_type_for(file_name) or "application/octet-stream",
            # Long, because the key is generated per upload: replacing a
            # picture makes a new URL rather than changing what this one means.
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
        },
    )


async def site_image_response(ctx: Ctx, file_name: str):
    """Serve the header background.

    The key is read from the settings row rather than assembled from the URL,
    so a stale link cannot be used to fish for other objects in the bucket.
    """

    file_name = unquote(file_name)
    try:
        site_chrome.validate_image_suffix(file_name)
    except site_chrome.SiteError:
        return ctx.error("Invalid image URL", 400)

    key = await site_chrome.header_image_key(ctx.env)
    if key != f"{site_chrome.IMAGE_PREFIX}/{file_name}":
        return ctx.error("Image not found", 404)
    stored = await ctx.env.IBON_IMAGES.get(key)
    if stored is None:
        return ctx.error("Image not found", 404)
    content = bytes(Uint8Array.new(await stored.arrayBuffer()).to_py())
    suffix = file_name[file_name.rfind(".") :].lower()
    return ctx.binary(
        content,
        {
            "content-type": site_chrome.IMAGE_CONTENT_TYPES[suffix],
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
        },
    )


async def shop_image_response(ctx: Ctx, file_name: str):
    """Serve one product photo.

    The key is resolved through `product_images` rather than assembled from
    the URL, so a request can only reach an object some product actually
    references — a stale link cannot be used to enumerate the bucket.
    """

    file_name = unquote(file_name)
    try:
        shop.validate_image_suffix(file_name)
    except ValueError:
        return ctx.error("Invalid photo URL", 400)

    key = await shop.image_key_for_file(ctx.env, file_name)
    if key is None:
        return ctx.error("Photo not found", 404)
    stored = await ctx.env.IBON_IMAGES.get(key)
    if stored is None:
        return ctx.error("Photo not found", 404)
    content = bytes(Uint8Array.new(await stored.arrayBuffer()).to_py())
    suffix = file_name[file_name.rfind(".") :].lower()
    return ctx.binary(
        content,
        {
            "content-type": shop.IMAGE_CONTENT_TYPES[suffix],
            "cache-control": "public, max-age=3600",
            "x-content-type-options": "nosniff",
        },
    )


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


async def dispatch(ctx: Ctx):
    path, method = ctx.path, ctx.method

    if path == "/api/health" and method == "GET":
        # Read-only: the admin deployment owns the schema, so a shortfall here
        # is a deploy-order problem to report rather than one to fix in place.
        return ctx.json({"ok": True, "migrations": await applied_migration_names(ctx.env)})

    if path == "/api/bio-link" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await bio_link_response(ctx)

    if path == "/api/bio-link/calendar" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await bio_link_calendar_response(ctx)

    if path.startswith("/r/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await bio_link_redirect_response(ctx, path.removeprefix("/r/"))

    if path.startswith(f"{bio_link.AVATAR_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {bio_link.AVATAR_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await bio_link_avatar_response(ctx, path.removeprefix(f"{bio_link.AVATAR_URL_PREFIX}/"))

    if path == "/auth/login" and method == "GET":
        if not ctx.allowed_origins:
            return ctx.error("Backend is missing ALLOWED_ORIGINS", 500)
        # Every attempt writes an oauth state row before the visitor has
        # proved anything, which is the one way a stranger can spend the D1
        # write quota that orders also depend on.
        if not await rate_limit.allows(ctx.env, rate_limit.CUSTOMER_LOGIN, ctx.request, "login"):
            return ctx.too_many_requests()
        return await auth_customer.begin_google_login(ctx)

    if path == "/auth/callback" and method == "GET":
        try:
            return await auth_customer.complete_google_login(ctx)
        except OAuthError:
            return ctx.error("Google login failed", 502)

    if path == "/auth/logout" and method == "POST":
        return await auth_customer.logout(ctx)

    # Everything below needs to know who is asking, if anyone is.
    if path == "/api/session" or path == "/api/profile" or path == "/api/checkout" or path.startswith("/api/orders"):
        customer = await auth_customer.current_customer(ctx.env, ctx.request)
        if customer is None:
            return ctx.error("Authentication required", 401)

        if path == "/api/session" and method == "GET":
            return ctx.json({"customer": customer})
        if path == "/api/profile" and method == "GET":
            return await profile_response(ctx, customer)
        if path == "/api/profile" and method == "PATCH":
            return await update_profile_response(ctx, customer)
        if path == "/api/checkout" and method == "POST":
            if not await rate_limit.allows(ctx.env, rate_limit.CHECKOUT, ctx.request, "checkout"):
                return ctx.too_many_requests()
            return await checkout_response(ctx, customer)
        if path == "/api/orders" and method == "GET":
            return ctx.json({"orders": await orders.list_for_customer(ctx.env, customer["id"])})
        if path.endswith("/fake-payment") and method == "POST":
            return await fake_payment_response(
                ctx, customer, path.removeprefix("/api/orders/").removesuffix("/fake-payment")
            )
        if path.startswith("/api/orders/") and method == "GET":
            return await order_response(ctx, customer, path.removeprefix("/api/orders/"))
        return ctx.error("Unknown endpoint", 404)

    if path == "/api/cart/validate" and method == "POST":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await cart_validate_response(ctx)

    if path == "/api/shipping-methods" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return ctx.json({"methods": await shipping.list_methods(ctx.env, only_enabled=True)})

    if path == "/api/site" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "site"):
            return ctx.too_many_requests()
        return await site_response(ctx)

    if path == "/api/pages/home" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await page_response(ctx, await pages.home_page(ctx.env))

    if path == "/api/pages" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        # The path arrives as a query parameter because it contains slashes of
        # its own; nesting it in the route would mean splicing and unsplicing
        # it at both ends.
        try:
            wanted = pages.validate_path((ctx.query.get("path") or [""])[0])
        except pages.PageError:
            return ctx.error("Page not found", 404)
        return await page_response(ctx, await pages.page_by_path(ctx.env, wanted))

    if path == "/api/categories" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await category_index_response(ctx)

    if path.startswith("/api/categories/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await category_page_response(ctx, path.removeprefix("/api/categories/"))

    if path == "/api/products" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await shop_index_response(ctx)

    if path.startswith("/api/products/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await shop_product_response(ctx, path.removeprefix("/api/products/"))

    if path.startswith(f"{site_chrome.IMAGE_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {site_chrome.IMAGE_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await site_image_response(ctx, path.removeprefix(f"{site_chrome.IMAGE_URL_PREFIX}/"))

    if path.startswith(f"{media.IMAGE_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {media.IMAGE_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await media_image_response(ctx, path.removeprefix(f"{media.IMAGE_URL_PREFIX}/"))

    if path.startswith(f"{shop.IMAGE_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {shop.IMAGE_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await shop_image_response(ctx, path.removeprefix(f"{shop.IMAGE_URL_PREFIX}/"))

    if path.startswith("/images/"):
        if method != "GET" or len(path.split("/")) != 4:
            return ctx.error("Use GET /images/{folder}/{file}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await public_image_response(ctx, path)

    if path.startswith("/api/print/"):
        if method != "GET":
            return ctx.error("Only GET is supported", 405)
        identifier = path.removeprefix("/api/print/")
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return ctx.error("Invalid id", 400)
        # A cold cache here means 15 MB out of R2 and a four-step upload to
        # ibon, so this is limited more tightly than the read-only routes.
        if not await rate_limit.allows(ctx.env, rate_limit.PRINT, ctx.request, "print"):
            return ctx.too_many_requests()
        return await print_response(ctx, identifier)

    # Links shared before the split still point at the old page and JSON URLs.
    if path.startswith("/ibon_print/") and method == "GET":
        identifier = path.removeprefix("/ibon_print/")
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return ctx.error("Invalid id", 400)
        if wants_json(ctx):
            if not await rate_limit.allows(ctx.env, rate_limit.PRINT, ctx.request, "print"):
                return ctx.too_many_requests()
            return await print_response(ctx, identifier)
        return frontend_redirect(ctx, f"/ibon_print/{identifier}")

    return ctx.error("Unknown endpoint", 404)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await router.serve(self.env, request, dispatch, owns_schema=False)

    async def scheduled(self, event):
        """Put back the stock of orders nobody finished paying for.

        Held stock has to expire or an abandoned cart takes the last item off
        the shelf permanently. It lives here rather than on the admin Worker
        because this is where the order lifecycle is; the admin deployment
        owns the schema, not the orders.
        """

        await orders.expire_unpaid(self.env)
