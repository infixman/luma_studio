"""Page and block editing on the admin deployment.

`admin_main.dispatch` has already established that the caller is signed in.
What happens here is validation: a page path that shadows the shop, or a
block whose config the frontend has no component for, must be refused at the
door rather than discovered by a visitor.
"""

import block_data
import pages
from responses import Ctx


async def _read_json(ctx: Ctx) -> dict:
    body = await ctx.request.json()
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    return body


async def _detail(ctx: Ctx, page: dict) -> dict:
    # Hydrated the same way the storefront is, because the editor previews
    # with the storefront's own components — a preview fed different data is
    # a preview of something else.
    blocks = await block_data.hydrate(ctx.env, await pages.list_blocks(ctx.env, page["id"]))
    return {
        "page": page,
        "blocks": blocks,
        # Three states, not two. `modified` is the one that was invisible
        # before versions existed: edited since it was last published, with
        # nothing on screen saying so.
        "publishState": await pages.publish_state(ctx.env, page["id"], blocks),
        "versions": await pages.list_versions(ctx.env, page["id"]),
    }


def _page_fields(body: dict, page: dict | None = None) -> dict:
    """The fields an ordinary save writes.

    Status is not one of them any more unless the body says so. Publishing
    owns it now — `/publish` and `/unpublish` — and a save that carried a
    stale `status: draft` along with a title change would take a live page
    down as a side effect of renaming it. A body that never mentions it keeps
    what is there, the same rule the chrome flags and the share image follow.
    """

    current = page["status"] if page else "draft"
    return {
        "path": pages.validate_path(body.get("path") or ""),
        "title": pages.validate_title(body.get("title") or ""),
        "status": pages.validate_status(str(body["status"])) if "status" in body else current,
    }


def _chrome_fields(body: dict) -> dict:
    """Default to on when the field is absent.

    An older client that does not know about these must not silently strip a
    page's header off.
    """

    return {
        "show_header": bool(body.get("showHeader", True)),
        "show_footer": bool(body.get("showFooter", True)),
    }


async def _share_fields(ctx: Ctx, body: dict, page: dict) -> dict:
    """The preview card's text and image.

    A body that never mentions the image leaves the stored one alone, for the
    same reason the chrome flags default to on: an older client must not strip
    a page's preview image off just by saving the title.
    """

    key = page["shareImageKey"]
    if "shareImageId" in body:
        key = await pages.resolve_share_image_key(ctx.env, body["shareImageId"])
    return {
        "share_description": pages.validate_share_description(body.get("shareDescription")),
        "share_image_key": key,
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/pages" and method == "GET":
        return ctx.json({"pages": await pages.list_pages(env)})

    if path == "/api/pages" and method == "POST":
        try:
            fields = _page_fields(await _read_json(ctx))
        except pages.PageError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid page", 400)
        if await pages.path_taken(env, fields["path"]):
            return ctx.error("已經有頁面使用這個路徑", 409)
        page_id = await pages.create_page(env, **fields)
        return ctx.json(await _detail(ctx, await pages.get_page(env, page_id)), 201)

    # Before the {id} routes, or "order" would be read as a page id.
    if path == "/api/pages/order" and method == "PUT":
        try:
            raw = (await _read_json(ctx)).get("ids")
            if not isinstance(raw, list):
                raise ValueError("Expected an array of page ids")
            ordered = [pages.validate_id(str(value)) for value in raw]
        except pages.PageError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid ordering", 400)
        await pages.reorder_pages(env, ordered)
        return ctx.json({"pages": await pages.list_pages(env)})

    if path.startswith("/api/pages/"):
        rest = path.removeprefix("/api/pages/")
        page_id, _, tail = rest.partition("/")
        try:
            page_id = pages.validate_id(page_id)
        except pages.PageError as error:
            return ctx.error(str(error), 400)

        page = await pages.get_page(env, page_id)
        if page is None:
            return ctx.error("Page not found", 404)

        if not tail and method == "GET":
            return ctx.json(await _detail(ctx, page))

        if not tail and method == "PUT":
            try:
                body = await _read_json(ctx)
                fields = {**_page_fields(body, page), **_chrome_fields(body), **await _share_fields(ctx, body, page)}
            except pages.PageError as error:
                return ctx.error(str(error), 400)
            except (ValueError, AttributeError):
                return ctx.error("Invalid page", 400)
            if await pages.path_taken(env, fields["path"], excluding=page_id):
                return ctx.error("已經有頁面使用這個路徑", 409)
            await pages.update_page(env, page_id, **fields)
            # The home flag travels with the page rather than on its own
            # endpoint: setting it moves it off whoever held it, and that is
            # one decision, not two requests that can half-apply.
            if "isHome" in body:
                if bool(body["isHome"]):
                    await pages.set_home(env, page_id)
                else:
                    await pages.clear_home(env, page_id)
            return ctx.json(await _detail(ctx, await pages.get_page(env, page_id)))

        if not tail and method == "DELETE":
            await pages.delete_page(env, page_id)
            return ctx.json({"id": page_id, "deleted": True})

        # Only reachable behind this host's sign-in gate, which is what makes
        # the token safe to hand out: the storefront trusts the token because
        # only somebody already signed in here could have been given one.
        if tail == "preview-token" and method == "POST":
            token = await pages.mint_preview_token(env, page_id)
            return ctx.json({"token": token, "expiresIn": pages.PREVIEW_TTL_SECONDS})

        if tail == "publish" and method == "POST":
            # Publishing a page with nothing on it would take an empty page
            # live, and the reason to do that is hard to imagine next to the
            # reason to do it by accident.
            if not await pages.list_blocks(env, page_id):
                return ctx.error("這一頁還沒有任何區塊，先加一個再發布", 409)
            await pages.publish(env, page_id, getattr(ctx, "admin_email", ""))
            return ctx.json(await _detail(ctx, await pages.get_page(env, page_id)))

        if tail == "unpublish" and method == "POST":
            await pages.unpublish(env, page_id)
            return ctx.json(await _detail(ctx, await pages.get_page(env, page_id)))

        if tail.startswith("versions/") and method == "GET":
            # What this version would cost to restore, asked before the
            # dialog is drawn so it can say "2 of the 5 products it names are
            # gone" rather than leaving it to be discovered afterwards.
            version_id = tail.removeprefix("versions/").removesuffix("/changes")
            payload = await pages.version_payload(env, page_id, version_id)
            if payload is None:
                return ctx.error("Version not found", 404)
            return ctx.json({"missing": await block_data.missing(env, pages.blocks_of_snapshot(payload))})

        if tail.startswith("versions/") and method == "POST":
            version_id = tail.removeprefix("versions/").removesuffix("/restore")
            if not await pages.restore(env, page_id, version_id):
                return ctx.error("Version not found", 404)
            # Into the draft, not onto the site. The 發布 button finishes it.
            return ctx.json(await _detail(ctx, await pages.get_page(env, page_id)))

        if tail == "blocks" and method == "POST":
            try:
                body = await _read_json(ctx)
                block_type, config = pages.validate_block(str(body.get("type") or ""), body.get("config") or {})
            except pages.PageError as error:
                return ctx.error(str(error), 400)
            except (ValueError, AttributeError):
                return ctx.error("Invalid block", 400)
            if await pages.count_blocks(env, page_id) >= pages.MAX_BLOCKS:
                return ctx.error(f"一頁最多 {pages.MAX_BLOCKS} 個區塊", 409)
            await pages.add_block(env, page_id, block_type, config)
            return ctx.json(await _detail(ctx, page), 201)

        if tail == "blocks/order" and method == "PUT":
            try:
                raw = (await _read_json(ctx)).get("ids")
                if not isinstance(raw, list):
                    raise ValueError("Expected an array of block ids")
                ordered = [pages.validate_id(str(value)) for value in raw]
            except pages.PageError as error:
                return ctx.error(str(error), 400)
            except (ValueError, AttributeError):
                return ctx.error("Invalid ordering", 400)
            if not await pages.reorder_blocks(env, page_id, ordered):
                return ctx.error("順序必須包含這一頁的每一個區塊", 400)
            return ctx.json(await _detail(ctx, page))

        return ctx.error("Unknown page endpoint", 404)

    if path.startswith("/api/blocks/") and method in {"PUT", "DELETE"}:
        try:
            block_id = pages.validate_id(path.removeprefix("/api/blocks/"))
        except pages.PageError as error:
            return ctx.error(str(error), 400)

        block = await pages.get_block(env, block_id)
        if block is None:
            return ctx.error("Block not found", 404)
        owner = await pages.page_id_of_block(env, block_id)

        if method == "DELETE":
            await pages.delete_block(env, block_id)
        else:
            try:
                body = await _read_json(ctx)
                _, config = pages.validate_block(block["type"], body.get("config") or {})
            except pages.PageError as error:
                return ctx.error(str(error), 400)
            except (ValueError, AttributeError):
                return ctx.error("Invalid block", 400)
            await pages.update_block(env, block_id, config)

        return ctx.json(await _detail(ctx, await pages.get_page(env, owner)))

    return ctx.error("Unknown page endpoint", 404)
