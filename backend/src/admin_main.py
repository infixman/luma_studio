"""Cloudflare Python Worker: the administration API, behind Google sign-in.

Deployed apart from the public API and reached only at
admin-api.luma-studio.tw. The split buys one thing that a shared deployment
cannot: the admin session cookie is host-only to this hostname, so a script
injected into the storefront has no path to it at all.

It also means the routing table needs no `/api/admin` prefix. Every endpoint
here is administration, so authentication is a single gate near the top
rather than a condition each route has to remember to apply.

This Worker owns the D1 schema. See `router.serve`.
"""

from workers import WorkerEntrypoint

import admin_api
import auth_admin
import bio_link_api
import rate_limit
import router
import shop_admin_api
from common import OAuthError
from migrations import apply_migrations
from responses import Ctx


async def dispatch(ctx: Ctx):
    path, method = ctx.path, ctx.method

    if path == "/api/health" and method == "GET":
        return ctx.json({"ok": True, "migrations": await apply_migrations(ctx.env)})

    if path == "/auth/login" and method == "GET":
        if not ctx.allowed_origins:
            return ctx.error("Backend is missing ALLOWED_ORIGINS", 500)
        # Every attempt writes an oauth state row before the visitor has
        # proved anything, so this is the tightest limit on the deployment.
        if not await rate_limit.allows(ctx.env, rate_limit.LOGIN, ctx.request, "login"):
            return ctx.too_many_requests()
        return await auth_admin.begin_google_login(ctx)

    if path == "/auth/callback" and method == "GET":
        try:
            return await auth_admin.complete_google_login(ctx)
        except OAuthError:
            return ctx.error("Google login failed", 502)

    if path == "/auth/logout" and method == "POST":
        return await auth_admin.logout(ctx)

    # Past this line every route is administration, so the check happens once.
    email = await auth_admin.get_admin_email(ctx.env, ctx.request)
    if not email:
        return ctx.error("Authentication required", 401)

    if path == "/api/session" and method == "GET":
        return ctx.json({"email": email})

    if path == "/api/bio-link" or path.startswith("/api/bio-link/"):
        return await bio_link_api.handle(ctx)

    if (
        path == "/api/products"
        or path.startswith("/api/products/")
        or path.startswith("/api/variants/")
        or path.startswith("/api/images/")
    ):
        return await shop_admin_api.handle(ctx)

    return await admin_api.handle(ctx)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return await router.serve(self.env, request, dispatch, owns_schema=True)
