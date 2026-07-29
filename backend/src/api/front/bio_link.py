"""Public bio-link response handlers."""

from urllib.parse import unquote

import workers

from domain import bio_link
from shared.common import CACHE_1H, IMAGE_CONTENT_TYPES
from shared.responses import Ctx, serve_r2_image


async def response(ctx: Ctx):
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
            "style": {"theme": settings["theme"], "buttonShape": settings["buttonShape"], "fontStyle": settings["fontStyle"]},
            "hasCalendar": bool(settings["calendarEnabled"] and settings["calendarUrl"]),
            "links": [{"id": item["id"], "title": item["title"]} for item in items if item["kind"] == "link"],
            "socials": [{"id": item["id"], "title": item["title"], "platform": item["platform"]} for item in items if item["kind"] == "social"],
        }
    )


async def calendar_response(ctx: Ctx):
    settings = await bio_link.get_settings(ctx.env)
    return ctx.json({"calendar": await bio_link.fetch_calendar(ctx.env, settings)})


async def redirect_response(ctx: Ctx, item_id: str):
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


async def avatar_response(ctx: Ctx, file_name: str):
    file_name = unquote(file_name)
    suffix = file_name[file_name.rfind(".") :].lower()
    if "/" in file_name or ".." in file_name or suffix not in bio_link.AVATAR_SUFFIXES:
        return ctx.error("Invalid avatar URL", 400)
    return await serve_r2_image(ctx, ctx.env.IBON_IMAGES, f"{bio_link.AVATAR_PREFIX}/{file_name}", IMAGE_CONTENT_TYPES, CACHE_1H)
