"""Cloudflare Python Worker entrypoint for the public JSON API.

The browser interface is a separate deployment.  Administration is served by
`admin_main.py` on another hostname, so the two session cookies never share an
origin.  Response construction lives in `front_api`; this file keeps only
route selection, authentication boundaries, and Worker lifecycle hooks.
"""

import auth_customer
from domain import bio_link, media, orders, pages, shipping, shop, site_chrome
import front_api
import mail
import rate_limit
import router
from common import IDENTIFIER_PATTERN, OAuthError
from migrations import applied_migration_names
from responses import Ctx
from workers import WorkerEntrypoint


async def dispatch(ctx: Ctx):
    path, method = ctx.path, ctx.method

    if path == "/api/health" and method == "GET":
        # The admin deployment owns the schema, so a shortfall here is a
        # deploy-order problem to report rather than one to fix in place.
        return ctx.json({"ok": True, "migrations": await applied_migration_names(ctx.env)})

    if path == "/api/bio-link" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await front_api.bio_link_response(ctx)

    if path == "/api/bio-link/calendar" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await front_api.bio_link_calendar_response(ctx)

    if path.startswith("/r/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await front_api.bio_link_redirect_response(ctx, path.removeprefix("/r/"))

    if path.startswith(f"{bio_link.AVATAR_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {bio_link.AVATAR_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await front_api.bio_link_avatar_response(ctx, path.removeprefix(f"{bio_link.AVATAR_URL_PREFIX}/"))

    if path == "/auth/login" and method == "GET":
        if not ctx.allowed_origins:
            return ctx.error("Backend is missing ALLOWED_ORIGINS", 500)
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
            return await front_api.profile_response(ctx, customer)
        if path == "/api/profile" and method == "PATCH":
            if not await rate_limit.allows(ctx.env, rate_limit.CHECKOUT, ctx.request, "profile"):
                return ctx.too_many_requests()
            return await front_api.update_profile_response(ctx, customer)
        if path == "/api/checkout" and method == "POST":
            if not await rate_limit.allows(ctx.env, rate_limit.CHECKOUT, ctx.request, "checkout"):
                return ctx.too_many_requests()
            return await front_api.checkout_response(ctx, customer)
        if path == "/api/orders" and method == "GET":
            return ctx.json({"orders": await orders.list_cards_for_customer(ctx.env, customer["id"])})
        if path.endswith("/fake-payment") and method == "POST":
            return await front_api.fake_payment_response(
                ctx, customer, path.removeprefix("/api/orders/").removesuffix("/fake-payment")
            )
        if path.startswith("/api/orders/") and method == "GET":
            return await front_api.order_response(ctx, customer, path.removeprefix("/api/orders/"))
        return ctx.error("Unknown endpoint", 404)

    if path == "/api/cart/validate" and method == "POST":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.cart_validate_response(ctx)

    if path == "/api/shipping-methods" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return ctx.json({"methods": await shipping.list_methods(ctx.env, only_enabled=True)})

    if path == "/api/site" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "site"):
            return ctx.too_many_requests()
        return await front_api.site_response(ctx)

    # This is before /api/pages/home because a token is not a page path.
    if path.startswith("/api/pages/preview/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.preview_response(ctx, path.removeprefix("/api/pages/preview/"))

    if path == "/api/pages/home" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.page_response(ctx, await pages.home_page(ctx.env))

    if path == "/api/pages" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        try:
            wanted = pages.validate_path((ctx.query.get("path") or [""])[0])
        except pages.PageError:
            return ctx.error("Page not found", 404)
        return await front_api.page_response(ctx, await pages.page_by_path(ctx.env, wanted))

    if path == "/api/categories" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.category_index_response(ctx)

    if path.startswith("/api/categories/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.category_page_response(ctx, path.removeprefix("/api/categories/"))

    if path == "/api/products" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.shop_index_response(ctx)

    if path.startswith("/api/products/") and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.SHOP, ctx.request, "shop"):
            return ctx.too_many_requests()
        return await front_api.shop_product_response(ctx, path.removeprefix("/api/products/"))

    if path.startswith(f"{site_chrome.IMAGE_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {site_chrome.IMAGE_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await front_api.site_image_response(ctx, path.removeprefix(f"{site_chrome.IMAGE_URL_PREFIX}/"))

    if path.startswith(f"{media.IMAGE_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {media.IMAGE_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await front_api.media_image_response(ctx, path.removeprefix(f"{media.IMAGE_URL_PREFIX}/"))

    if path.startswith(f"{shop.IMAGE_URL_PREFIX}/"):
        if method != "GET":
            return ctx.error(f"Use GET {shop.IMAGE_URL_PREFIX}/{{file}}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await front_api.shop_image_response(ctx, path.removeprefix(f"{shop.IMAGE_URL_PREFIX}/"))

    if path.startswith("/images/"):
        if method != "GET" or len(path.split("/")) != 4:
            return ctx.error("Use GET /images/{folder}/{file}", 404)
        if not await rate_limit.allows(ctx.env, rate_limit.ASSET, ctx.request, "asset"):
            return ctx.too_many_requests()
        return await front_api.public_image_response(ctx, path)

    if path.startswith("/api/print/"):
        if method != "GET":
            return ctx.error("Only GET is supported", 405)
        identifier = path.removeprefix("/api/print/")
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return ctx.error("Invalid id", 400)
        if not await rate_limit.allows(ctx.env, rate_limit.PRINT, ctx.request, "print"):
            return ctx.too_many_requests()
        return await front_api.print_response(ctx, identifier)

    # Links shared before the split still point at the old page and JSON URLs.
    if path.startswith("/ibon_print/") and method == "GET":
        identifier = path.removeprefix("/ibon_print/")
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return ctx.error("Invalid id", 400)
        if front_api.wants_json(ctx):
            if not await rate_limit.allows(ctx.env, rate_limit.PRINT, ctx.request, "print"):
                return ctx.too_many_requests()
            return await front_api.print_response(ctx, identifier)
        return front_api.frontend_redirect(ctx, f"/ibon_print/{identifier}")

    return ctx.error("Unknown endpoint", 404)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await router.serve(self.env, request, dispatch, owns_schema=False)

    async def scheduled(self, event):
        await orders.expire_unpaid(self.env)
        await mail.send_pending(self.env)
        await auth_customer.purge_expired(self.env)
