"""Cloudflare Python Worker: the public JSON API.

This Worker renders no HTML. The browser interface is a separate deployment
that talks to these endpoints cross-origin.

Administration lives in `admin_main.py` on its own hostname, which is what
keeps the admin session cookie out of reach of anything served here. This
deployment also never applies a migration — see `router.serve`.

One exception, and it is temporary: the admin interface has not moved hosts
yet, so the old /api/admin/* routes are still bridged from here. See
`legacy_admin_response`.
"""

from urllib.parse import unquote

import workers
from workers import WorkerEntrypoint

import admin_main
import bio_link
import cart
import rate_limit
import router
import shipping
import shop
from common import IDENTIFIER_PATTERN, IMAGE_CONTENT_TYPES, IbonError, validate_file_name, validate_folder
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


async def legacy_admin_response(ctx: Ctx):
    """Serve the pre-split admin routes until the back office changes host.

    TEMPORARY. The admin interface is still deployed at luma-studio.tw and
    still calls /api/admin/* here, so removing these in the same change as
    the split would take the back office down between two deploys. They are
    deleted in one piece once admin.luma-studio.tw is live — along with this
    function, the `admin_main` import above, and the routes below.

    The old prefix is rewritten to the new shape and handed to the admin
    Worker's own dispatcher, so there is one routing table rather than two
    that can disagree about who is allowed in.
    """

    if ctx.path.startswith("/api/admin/"):
        ctx.path = "/api/" + ctx.path.removeprefix("/api/admin/")
    return await admin_main.dispatch(ctx)


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

    # TEMPORARY, removed with the frontend split. See legacy_admin_response.
    if path.startswith("/api/admin") or path.startswith("/auth/") or path == "/api/session":
        return await legacy_admin_response(ctx)
    if path == "/admin" and method == "GET":
        return frontend_redirect(ctx, "/admin")

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

    if path == "/api/cart/validate" and method == "POST":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await cart_validate_response(ctx)

    if path == "/api/shipping-methods" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return ctx.json({"methods": await shipping.list_methods(ctx.env, only_enabled=True)})

    if path == "/api/products" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await shop_index_response(ctx)

    if path.startswith("/api/products/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await shop_product_response(ctx, path.removeprefix("/api/products/"))

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
