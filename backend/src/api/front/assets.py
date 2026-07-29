"""Public R2 asset and print response handlers."""

from urllib.parse import unquote

from domain import media, shop, site_chrome
from shared.common import CACHE_1D, CACHE_1H, IMAGE_CONTENT_TYPES, IbonError, validate_file_name, validate_folder
from ibon import resolve_print_result
from shared.responses import Ctx, frontend_origin, serve_r2_image


def wants_json(ctx: Ctx) -> bool:
    requested = (ctx.query.get("format") or [""])[0].lower()
    if requested == "json":
        return True
    if requested == "html":
        return False
    accept = ctx.request.headers.get("Accept") or ""
    return "application/json" in accept and "text/html" not in accept


async def public_image_response(ctx: Ctx, path: str):
    _, _, folder, file_name = path.split("/", 3)
    try:
        folder, file_name = validate_folder(unquote(folder)), validate_file_name(unquote(file_name))
    except ValueError:
        return ctx.error("Invalid image URL", 400)
    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, f"{folder}/{file_name}", IMAGE_CONTENT_TYPES, CACHE_1H)


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
