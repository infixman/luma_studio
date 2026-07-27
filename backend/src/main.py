"""Cloudflare Python Worker: JSON API for ibon uploads and R2 administration.

This Worker renders no HTML. The browser interface is a separate deployment
that talks to these endpoints cross-origin.
"""

from urllib.parse import parse_qs, unquote

from workers import WorkerEntrypoint

import admin_api
import auth
import bio_link
import bio_link_api
import rate_limit
from common import IDENTIFIER_PATTERN, IMAGE_CONTENT_TYPES, IbonError, MigrationError, OAuthError, validate_file_name, validate_folder
from ibon import resolve_print_result
from js import Uint8Array
from migrations import apply_migrations
from responses import Ctx, frontend_origin


def needs_database(path: str) -> bool:
    """Serving an R2 object must not depend on D1 being reachable."""

    return not path.startswith("/images/") and not path.startswith(f"{bio_link.AVATAR_URL_PREFIX}/")


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
    """The public bio link page's content, plus one view event per visitor."""

    settings = await bio_link.get_settings(ctx.env)
    items = await bio_link.list_items(ctx.env, only_enabled=True)
    await bio_link.record_event(ctx.env, ctx.request, "view")
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
            "calendar": await bio_link.fetch_calendar(ctx.env, settings),
            # Anonymous visitors get only what the page renders.
            "links": [{"id": item["id"], "title": item["title"]} for item in items if item["kind"] == "link"],
            "socials": [
                {"id": item["id"], "title": item["title"], "platform": item["platform"]}
                for item in items
                if item["kind"] == "social"
            ],
        }
    )


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
        # Each attempt writes an oauth state row, so this is the one public
        # endpoint that can spend the D1 write quota without being asked to.
        if not await rate_limit.allows(ctx.env, rate_limit.LOGIN, ctx.request, "login"):
            return ctx.too_many_requests()
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
        if path == "/api/admin/bio-link" or path.startswith("/api/admin/bio-link/"):
            return await bio_link_api.handle(ctx)
        return await admin_api.handle(ctx)

    if path == "/api/bio-link" and method == "GET":
        if not await rate_limit.allows(ctx.env, rate_limit.PUBLIC, ctx.request, "bio"):
            return ctx.too_many_requests()
        return await bio_link_response(ctx)

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
