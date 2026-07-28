"""The media library on the admin deployment.

`admin_main.dispatch` has already established that the caller is signed in.
What happens here is the two-step nature of an upload: an object in R2 and a
row in D1 that points at it, in an order that leaves nothing dangling if the
second step never happens.
"""

import media
from responses import Ctx


async def _read_json(ctx: Ctx) -> dict:
    body = await ctx.request.json()
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    return body


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/media" and method == "GET":
        search = (ctx.query.get("q") or [""])[0]
        items, truncated = await media.list_media(env, search=search)
        return ctx.json({"media": items, "truncated": truncated})

    # Before the /api/media/{id} block below, which would read "tags" as an id
    # and refuse it. Same rule as the order and category routes.
    if path == "/api/media/tags" and method == "GET":
        return ctx.json({"tags": await media.list_tags(env)})

    if path == "/api/media" and method == "POST":
        try:
            form = await ctx.request.form_data()
            uploaded = form.get("file")
            if uploaded is None:
                raise media.MediaError("缺少檔案")
            file_name = media.clean_file_name(uploaded.name)
            suffix = media.validate_image_suffix(file_name)
            title = media.validate_title(form.get("title"))
            alt = media.validate_alt(form.get("alt"))
            content = await uploaded.bytes()
            if not content or len(content) > media.MAX_IMAGE_BYTES:
                raise media.MediaError("圖片必須介於 1 byte 與 5 MB 之間")
        except media.MediaError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid upload", 400)

        # The object first: a row pointing at nothing is an image the library
        # offers and the site cannot draw. An object with no row is only
        # storage, and the next upload does not trip over it.
        key = media.object_key(suffix)
        await env.IBON_IMAGES.put(key, content)
        row = await media.create(
            env, object_key=key, file_name=file_name, title=title, alt=alt, byte_size=len(content)
        )
        return ctx.json({"item": row}, 201)

    if path.startswith("/api/media/"):
        try:
            media_id = media.validate_id(path.removeprefix("/api/media/"))
        except media.MediaError as error:
            return ctx.error(str(error), 400)

        if method == "GET":
            item = await media.get_media(env, media_id)
            if item is None:
                return ctx.error("Media not found", 404)
            return ctx.json({"item": item, "usedBy": await media.usage(env, media_id)})

        if method == "PUT":
            try:
                body = await _read_json(ctx)
                title = media.validate_title(body.get("title"))
                alt = media.validate_alt(body.get("alt"))
                tags = media.validate_tags(body.get("tags"))
            except media.MediaError as error:
                return ctx.error(str(error), 400)
            except (ValueError, AttributeError):
                return ctx.error("Invalid media", 400)
            if not await media.update(env, media_id, title=title, alt=alt, tags=tags):
                return ctx.error("Media not found", 404)
            return ctx.json({"item": await media.get_media(env, media_id)})

        if method == "DELETE":
            # Deleting an image a page is using is allowed, but not by
            # accident: the answer says where it is used, and the owner has to
            # ask again. Refusing outright would mean an image could only be
            # removed by first editing every page that mentions it.
            used_by = await media.usage(env, media_id)
            if used_by and (ctx.query.get("force") or [""])[0] != "1":
                return ctx.json({"error": "這張圖還被頁面使用中", "usedBy": used_by}, 409)
            key = await media.delete(env, media_id)
            if key is None:
                return ctx.error("Media not found", 404)
            await env.IBON_IMAGES.delete(key)
            # The list comes back filtered the same way it was asked for, so
            # deleting from a search does not silently drop the search.
            items, truncated = await media.list_media(env, search=(ctx.query.get("q") or [""])[0])
            return ctx.json({"media": items, "truncated": truncated})

    return ctx.error("Not found", 404)
