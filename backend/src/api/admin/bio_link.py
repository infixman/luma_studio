"""Bio-link editing on the admin deployment, under /api/bio-link.

The public API serves a read-only /api/bio-link of its own. Same path, other
hostname, and no way to confuse the two: the cookies that authorise this one
are never sent to the other.
"""

from domain import bio_link
from shared.responses import Ctx


async def _state(ctx: Ctx) -> dict:
    settings = await bio_link.get_settings(ctx.env)
    # avatarKey is the storage detail behind avatarPath; the editor never
    # needs it, so it stays out of the payload.
    return {
        "displayName": settings["displayName"],
        "bio": settings["bio"],
        "avatarPath": settings["avatarPath"],
        "theme": settings["theme"],
        "buttonShape": settings["buttonShape"],
        "fontStyle": settings["fontStyle"],
        "calendarUrl": settings["calendarUrl"],
        "calendarTitle": settings["calendarTitle"],
        "calendarCount": settings["calendarCount"],
        "calendarEnabled": settings["calendarEnabled"],
        "items": await bio_link.list_items(ctx.env),
    }


def _settings_from(body: dict, current: dict) -> dict:
    """Validate everything the editor sent, falling back to what is stored."""

    def given(key, fallback):
        return body[key] if key in body else fallback

    return {
        "displayName": bio_link.validate_text(
            str(given("displayName", current["displayName"]) or ""), bio_link.MAX_DISPLAY_NAME, "Display name", required=False
        ),
        "bio": bio_link.validate_text(str(given("bio", current["bio"]) or ""), bio_link.MAX_BIO, "Bio", required=False),
        "theme": bio_link.validate_choice(given("theme", current["theme"]), bio_link.THEMES, "Theme"),
        "buttonShape": bio_link.validate_choice(
            given("buttonShape", current["buttonShape"]), bio_link.BUTTON_SHAPES, "Button shape"
        ),
        "fontStyle": bio_link.validate_choice(given("fontStyle", current["fontStyle"]), bio_link.FONT_STYLES, "Font style"),
        "calendarUrl": bio_link.validate_calendar_url(str(given("calendarUrl", current["calendarUrl"]) or "")),
        "calendarTitle": bio_link.validate_text(
            str(given("calendarTitle", current["calendarTitle"]) or "近期課程"),
            bio_link.MAX_CALENDAR_TITLE,
            "Calendar title",
            required=False,
        )
        or "近期課程",
        "calendarCount": bio_link.validate_calendar_count(given("calendarCount", current["calendarCount"])),
        "calendarEnabled": bool(given("calendarEnabled", current["calendarEnabled"])),
    }


def _items_from(body: dict) -> list[dict]:
    """Validate the whole link list, in the order the editor sent it."""

    raw = body.get("items")
    if not isinstance(raw, list):
        raise ValueError("Expected an array of links")
    if len(raw) > bio_link.MAX_ITEMS:
        raise ValueError(f"The page can hold at most {bio_link.MAX_ITEMS} links")

    items = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("Each link must be an object")
        kind = bio_link.validate_kind(str(entry.get("kind") or "link"))
        item_id = entry.get("id")
        items.append(
            {
                "id": bio_link.validate_item_id(str(item_id)) if item_id else None,
                "kind": kind,
                "title": bio_link.validate_text(str(entry.get("title") or ""), bio_link.MAX_TITLE, "Title"),
                "url": bio_link.validate_url(str(entry.get("url") or "")),
                "platform": bio_link.validate_platform(kind, entry.get("platform")),
                "enabled": bool(entry.get("enabled", True)),
            }
        )
    return items


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/bio-link" and method == "GET":
        return ctx.json(await _state(ctx))

    if path == "/api/bio-link/stats" and method == "GET":
        raw_days = (ctx.query.get("days") or [""])[0]
        try:
            days = int(raw_days) if raw_days else bio_link.DEFAULT_STATS_DAYS
        except ValueError:
            return ctx.error("days must be a number", 400)
        return ctx.json(await bio_link.get_stats(env, days))

    if path == "/api/bio-link" and method == "PUT":
        # One save for the whole page. Validate all of it before writing any
        # of it, so a rejected link cannot leave the settings half-changed.
        try:
            body = await ctx.json_body()
            settings = _settings_from(body, await bio_link.get_settings(env))
            items = _items_from(body) if "items" in body else None
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid settings", 400)
        await bio_link.save_settings(env, settings)
        if items is not None:
            await bio_link.replace_items(env, items)
        return ctx.json(await _state(ctx))

    if path == "/api/bio-link/calendar/test" and method == "POST":
        # The owner cannot tell a wrong address from an empty calendar, so
        # say which it is instead of leaving the section silently blank.
        try:
            body = await ctx.json_body()
            url = bio_link.validate_calendar_url(str(body.get("calendarUrl") or ""))
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid calendar address", 400)
        if not url:
            return ctx.error("請先填入行事曆網址", 400)

        current = await bio_link.get_settings(env)
        probe = {**current, "calendarUrl": url, "calendarEnabled": True, "calendarCount": bio_link.MAX_CALENDAR_COUNT}
        calendar = await bio_link.fetch_calendar(env, probe)
        if calendar is None:
            return ctx.error("讀不到這個行事曆。確認網址正確，且該行事曆已設為公開。", 400)
        return ctx.json({"count": len(calendar["events"]), "events": calendar["events"][:3]})

    if path == "/api/bio-link/avatar" and method == "POST":
        try:
            form = await ctx.request.form_data()
            uploaded = form.get("file")
            if uploaded is None:
                raise ValueError("Missing multipart file field")
            file_name = str(uploaded.name)
            suffix = file_name[file_name.rfind(".") :].lower()
            if suffix not in bio_link.AVATAR_SUFFIXES:
                raise ValueError("An avatar must be a jpg, png, gif or webp image")
            content = await uploaded.bytes()
            if not content or len(content) > bio_link.MAX_AVATAR_BYTES:
                raise ValueError("An avatar must be between 1 byte and 2 MB")
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid avatar upload", 400)

        previous = (await bio_link.get_settings(env))["avatarKey"]
        key = bio_link.avatar_key(suffix)
        await env.IBON_IMAGES.put(key, content)
        # Point at the new object before deleting the old one, so a failure
        # never leaves the page referencing something already gone.
        await bio_link.set_avatar_key(env, key)
        if previous and previous != key:
            await env.IBON_IMAGES.delete(previous)
        return ctx.json(await _state(ctx), 201)

    if path == "/api/bio-link/avatar" and method == "DELETE":
        previous = (await bio_link.get_settings(env))["avatarKey"]
        await bio_link.set_avatar_key(env, None)
        if previous:
            await env.IBON_IMAGES.delete(previous)
        return ctx.json(await _state(ctx))

    if path == "/api/bio-link/items" and method == "POST":
        try:
            body = await ctx.json_body()
            kind = bio_link.validate_kind(str(body.get("kind") or "link"))
            title = bio_link.validate_text(str(body.get("title") or ""), bio_link.MAX_TITLE, "Title")
            url = bio_link.validate_url(str(body.get("url") or ""))
            platform = bio_link.validate_platform(kind, body.get("platform"))
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid link", 400)
        if await bio_link.count_items(env) >= bio_link.MAX_ITEMS:
            return ctx.error(f"The page can hold at most {bio_link.MAX_ITEMS} links", 409)
        await bio_link.create_item(env, kind, title, url, platform)
        return ctx.json(await _state(ctx), 201)

    if path == "/api/bio-link/items/order" and method == "PUT":
        try:
            body = await ctx.json_body()
            raw_ids = body.get("ids")
            if not isinstance(raw_ids, list):
                raise ValueError("Expected an array of link ids")
            ordered = [bio_link.validate_item_id(str(item_id)) for item_id in raw_ids]
            await bio_link.reorder_items(env, ordered)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid ordering", 400)
        return ctx.json(await _state(ctx))

    if path.startswith("/api/bio-link/items/") and method in {"PUT", "DELETE"}:
        try:
            item_id = bio_link.validate_item_id(path.removeprefix("/api/bio-link/items/"))
        except ValueError as error:
            return ctx.error(str(error), 400)

        if method == "DELETE":
            if not await bio_link.delete_item(env, item_id):
                return ctx.error("Link not found", 404)
            return ctx.json(await _state(ctx))

        try:
            body = await ctx.json_body()
            title = bio_link.validate_text(str(body.get("title") or ""), bio_link.MAX_TITLE, "Title")
            url = bio_link.validate_url(str(body.get("url") or ""))
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid link", 400)
        if not await bio_link.update_item(env, item_id, title, url, bool(body.get("enabled", True))):
            return ctx.error("Link not found", 404)
        return ctx.json(await _state(ctx))

    # Falling off the end used to hand the runtime a None response, which
    # surfaces as an opaque 500 rather than as the wrong URL it actually is.
    return ctx.error("Unknown bio-link endpoint", 404)
