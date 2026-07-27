"""Cloudflare Python Worker: JSON API for ibon uploads and R2 administration.

This Worker renders no HTML. The browser interface is a separate deployment
that talks to these endpoints cross-origin.
"""

from urllib.parse import parse_qs, unquote

from workers import WorkerEntrypoint

import admin_api
import auth
from common import IDENTIFIER_PATTERN, IMAGE_CONTENT_TYPES, IbonError, MigrationError, OAuthError, validate_file_name, validate_folder
from ibon import resolve_print_result
from js import Uint8Array
from migrations import apply_migrations
from responses import Ctx, frontend_origin


def needs_database(path: str) -> bool:
    """Serving an R2 image must not depend on D1 being reachable."""

    return not path.startswith("/images/")


def wants_html(ctx: Ctx) -> bool:
    """Only send browsers to the frontend; scripts still get JSON."""

    requested = (ctx.query.get("format") or [""])[0].lower()
    if requested == "json":
        return False
    return requested == "html" or "text/html" in (ctx.request.headers.get("Accept") or "")


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
        return ctx.json({"ok": True, "migrations": await apply_migrations(ctx.env)})

    if path == "/auth/login" and method == "GET":
        if not ctx.allowed_origins:
            return ctx.error("Backend is missing ALLOWED_ORIGINS", 500)
        return await auth.begin_google_login(ctx)
    if path == "/auth/callback" and method == "GET":
        try:
            return await auth.complete_google_login(ctx)
        except OAuthError:
            return ctx.error("Google login failed", 502)
    if path == "/auth/logout" and method == "POST":
        return await auth.logout(ctx)

    if path == "/api/session" and method == "GET":
        email = await auth.get_admin_email(ctx.env, ctx.request)
        if not email:
            return ctx.error("Authentication required", 401)
        return ctx.json({"email": email})

    if path.startswith("/api/admin/"):
        if not await auth.get_admin_email(ctx.env, ctx.request):
            return ctx.error("Authentication required", 401)
        return await admin_api.handle(ctx)

    if path.startswith("/images/"):
        if method != "GET" or len(path.split("/")) != 4:
            return ctx.error("Use GET /images/{folder}/{file}", 404)
        return await public_image_response(ctx, path)

    if path.startswith("/api/print/"):
        if method != "GET":
            return ctx.error("Only GET is supported", 405)
        identifier = path.removeprefix("/api/print/")
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return ctx.error("Invalid id", 400)
        return await print_response(ctx, identifier)

    # Links shared before the split still point at the old page and JSON URLs.
    if path.startswith("/ibon_print/") and method == "GET":
        identifier = path.removeprefix("/ibon_print/")
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return ctx.error("Invalid id", 400)
        if wants_html(ctx):
            return frontend_redirect(ctx, f"/ibon_print/{identifier}")
        return await print_response(ctx, identifier)
    if path == "/admin" and method == "GET":
        return frontend_redirect(ctx, "/admin")

    return ctx.error("Unknown endpoint", 404)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        request_url = str(request.url)
        scheme_end = request_url.find("://")
        path_start = request_url.find("/", scheme_end + 3)
        path_and_query = request_url[path_start:] if path_start >= 0 else "/"
        path, _, raw_query = path_and_query.partition("?")
        path = path.rstrip("/") or "/"
        ctx = Ctx(self.env, request, path, parse_qs(raw_query))

        if ctx.method == "OPTIONS":
            return ctx.preflight()

        if not ctx.has_csrf_protection():
            if not ctx.allowed_origins:
                return ctx.error("Backend is missing ALLOWED_ORIGINS", 500)
            return ctx.error("Cross-site request rejected", 403)

        if needs_database(path):
            try:
                await apply_migrations(self.env)
            except MigrationError as error:
                return ctx.json({"error": "Database migration failed", "migration": error.name}, 503)

        return await dispatch(ctx)
