"""Authenticated bio-link editing under /api/admin/bio-link."""

import bio_link
from responses import Ctx


async def _read_json(ctx: Ctx) -> dict:
    body = await ctx.request.json()
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    return body


async def _state(ctx: Ctx) -> dict:
    settings = await bio_link.get_settings(ctx.env)
    return {
        "displayName": settings["displayName"],
        "bio": settings["bio"],
        "avatarPath": settings["avatarPath"],
        "items": await bio_link.list_items(ctx.env),
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/admin/bio-link" and method == "GET":
        return ctx.json(await _state(ctx))

    if path == "/api/admin/bio-link" and method == "PUT":
        try:
            body = await _read_json(ctx)
            display_name = bio_link.validate_text(
                str(body.get("displayName") or ""), bio_link.MAX_DISPLAY_NAME, "Display name", required=False
            )
            bio = bio_link.validate_text(str(body.get("bio") or ""), bio_link.MAX_BIO, "Bio", required=False)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid settings", 400)
        await bio_link.save_settings(env, display_name, bio)
        return ctx.json(await _state(ctx))

    if path == "/api/admin/bio-link/avatar" and method == "POST":
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

    if path == "/api/admin/bio-link/avatar" and method == "DELETE":
        previous = (await bio_link.get_settings(env))["avatarKey"]
        await bio_link.set_avatar_key(env, None)
        if previous:
            await env.IBON_IMAGES.delete(previous)
        return ctx.json(await _state(ctx))

    if path == "/api/admin/bio-link/items" and method == "POST":
        try:
            body = await _read_json(ctx)
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

    if path == "/api/admin/bio-link/items/order" and method == "PUT":
        try:
            body = await _read_json(ctx)
            raw_ids = body.get("ids")
            if not isinstance(raw_ids, list):
                raise ValueError("Expected an array of link ids")
            ordered = [bio_link.validate_item_id(str(item_id)) for item_id in raw_ids]
            await bio_link.reorder_items(env, ordered)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid ordering", 400)
        return ctx.json(await _state(ctx))

    if path.startswith("/api/admin/bio-link/items/") and method in {"PUT", "DELETE"}:
        try:
            item_id = bio_link.validate_item_id(path.removeprefix("/api/admin/bio-link/items/"))
        except ValueError as error:
            return ctx.error(str(error), 400)

        if method == "DELETE":
            if not await bio_link.delete_item(env, item_id):
                return ctx.error("Link not found", 404)
            return ctx.json(await _state(ctx))

        try:
            body = await _read_json(ctx)
            title = bio_link.validate_text(str(body.get("title") or ""), bio_link.MAX_TITLE, "Title")
            url = bio_link.validate_url(str(body.get("url") or ""))
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid link", 400)
        if not await bio_link.update_item(env, item_id, title, url, bool(body.get("enabled", True))):
            return ctx.error("Link not found", 404)
        return ctx.json(await _state(ctx))

    return ctx.error("Unknown bio link endpoint", 404)
