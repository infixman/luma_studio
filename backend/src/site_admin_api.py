"""Site chrome and menu editing on the admin deployment.

The menu response here deliberately includes items pointing at a draft or
deleted page, flagged as broken. The public response withholds them — but an
item nobody can see is an item nobody can delete, so the editor sees
everything.
"""

import categories
import pages
import site_chrome
from responses import Ctx


async def _read_json(ctx: Ctx) -> dict:
    body = await ctx.request.json()
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    return body


async def _menu_state(ctx: Ctx) -> dict:
    """The menu, plus what an item may point at, so the editor needs one call."""

    env = ctx.env
    return {
        "menu": await site_chrome.list_menu(env),
        "pages": [
            {"id": page["id"], "title": page["title"], "path": "/" if page["isHome"] else page["path"], "status": page["status"]}
            for page in await pages.list_pages(env)
        ],
        "categories": [
            {"slug": category["slug"], "title": category["title"]} for category in await categories.list_all(env)
        ],
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/site" and method == "GET":
        return ctx.json({"settings": await site_chrome.get_settings(env)})

    if path == "/api/site" and method == "PUT":
        try:
            fields = site_chrome.validate_settings(await _read_json(ctx))
        except site_chrome.SiteError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid settings", 400)
        await site_chrome.save_settings(env, fields)
        return ctx.json({"settings": await site_chrome.get_settings(env)})

    if path == "/api/site/header-image" and method == "POST":
        try:
            form = await ctx.request.form_data()
            uploaded = form.get("file")
            if uploaded is None:
                raise site_chrome.SiteError("缺少檔案")
            suffix = site_chrome.validate_image_suffix(str(uploaded.name))
            content = await uploaded.bytes()
            if not content or len(content) > site_chrome.MAX_IMAGE_BYTES:
                raise site_chrome.SiteError("背景圖必須介於 1 byte 與 3 MB 之間")
        except site_chrome.SiteError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid upload", 400)

        previous = await site_chrome.header_image_key(env)
        key = site_chrome.image_key(suffix)
        await env.IBON_IMAGES.put(key, content)
        # Point at the new object before removing the old one, so a failure
        # never leaves the header referencing something already gone.
        await site_chrome.set_header_image(env, key)
        if previous and previous != key:
            await env.IBON_IMAGES.delete(previous)
        return ctx.json({"settings": await site_chrome.get_settings(env)}, 201)

    if path == "/api/site/header-image" and method == "DELETE":
        previous = await site_chrome.header_image_key(env)
        await site_chrome.set_header_image(env, None)
        if previous:
            await env.IBON_IMAGES.delete(previous)
        return ctx.json({"settings": await site_chrome.get_settings(env)})

    if path == "/api/menu" and method == "GET":
        return ctx.json(await _menu_state(ctx))

    if path == "/api/menu" and method == "POST":
        try:
            body = await _read_json(ctx)
            fields = site_chrome.validate_menu_fields(body)
            raw_parent = body.get("parentId")
            parent_id = site_chrome.validate_menu_id(str(raw_parent)) if raw_parent else None
            depth = site_chrome.depth_of(await site_chrome.list_menu(env), parent_id)
            if depth > site_chrome.MAX_MENU_DEPTH:
                raise site_chrome.SiteError(f"選單最多 {site_chrome.MAX_MENU_DEPTH} 層")
        except site_chrome.SiteError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid menu item", 400)
        if await site_chrome.count_menu(env) >= site_chrome.MAX_MENU_ITEMS:
            return ctx.error(f"選單最多 {site_chrome.MAX_MENU_ITEMS} 個項目", 409)
        await site_chrome.create_menu_item(env, parent_id=parent_id, **fields)
        return ctx.json(await _menu_state(ctx), 201)

    # Before the {id} route, or "order" would be read as a menu item id.
    if path == "/api/menu/order" and method == "PUT":
        try:
            raw = (await _read_json(ctx)).get("items")
            if not isinstance(raw, list):
                raise ValueError("Expected an array of menu items")
            ordered = [
                {
                    "id": site_chrome.validate_menu_id(str(entry.get("id"))),
                    "parentId": site_chrome.validate_menu_id(str(entry["parentId"])) if entry.get("parentId") else None,
                }
                for entry in raw
            ]
            # Depth is checked against the arrangement being submitted, not
            # the one in the database — otherwise a valid drag could be
            # rejected because of where the item used to sit.
            proposed = [{**entry, "id": entry["id"]} for entry in ordered]
            for entry in proposed:
                if site_chrome.depth_of(proposed, entry["parentId"]) > site_chrome.MAX_MENU_DEPTH:
                    raise site_chrome.SiteError(f"選單最多 {site_chrome.MAX_MENU_DEPTH} 層")
        except site_chrome.SiteError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError, KeyError):
            return ctx.error("Invalid ordering", 400)
        await site_chrome.reorder_menu(env, ordered)
        return ctx.json(await _menu_state(ctx))

    if path.startswith("/api/menu/") and method in {"PUT", "DELETE"}:
        try:
            menu_id = site_chrome.validate_menu_id(path.removeprefix("/api/menu/"))
        except site_chrome.SiteError as error:
            return ctx.error(str(error), 400)
        if await site_chrome.get_menu_item(env, menu_id) is None:
            return ctx.error("Menu item not found", 404)

        if method == "DELETE":
            await site_chrome.delete_menu_item(env, menu_id)
            return ctx.json(await _menu_state(ctx))

        try:
            fields = site_chrome.validate_menu_fields(await _read_json(ctx))
        except site_chrome.SiteError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid menu item", 400)
        await site_chrome.update_menu_item(env, menu_id, **fields)
        return ctx.json(await _menu_state(ctx))

    return ctx.error("Unknown site endpoint", 404)
