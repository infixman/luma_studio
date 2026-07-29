"""The media library on the admin deployment.

`admin_main.dispatch` has already established that the caller is signed in.
What happens here is the two-step nature of an upload: objects in R2 and a row
in D1 that points at them, in an order that leaves nothing dangling if the
second step never happens.

One upload carries several files: the original plus the widths the browser
rendered from it. The Worker does no scaling of its own — there is no image
library in a Python Worker — so its job is to check that what arrived is
plausible and to store all of it under one image.
"""

from domain import media
from shared import paging
from shared.responses import Ctx


async def _form_text(form, name: str) -> str:
    """Read a text field that Workers Python may have wrapped in a File."""
    raw = form.get(name)
    if raw is None:
        return ""
    if hasattr(raw, "bytes"):
        return (await raw.bytes()).decode("utf-8", errors="replace")
    return str(raw)


async def _read_variants(form) -> list[dict]:
    """The pre-scaled widths attached to an upload, if the browser made any.

    None at all is normal, not a failure: an image already narrower than the
    smallest target has nothing to scale down to, and a browser that could not
    decode the file still uploads the original. Both cases end with a library
    entry that simply has no variants.
    """

    variants = []
    for label in media.SIZE_LABELS:
        blob = form.get(f"size_{label}")
        if blob is None:
            continue
        width, height = media.validate_dimensions(await _form_text(form, f"size_{label}_dimensions"))
        if not width:
            raise media.MediaError(f"{label} 尺寸格式不正確")
        content = await blob.bytes()
        if not content or len(content) > media.MAX_VARIANT_BYTES:
            raise media.MediaError(f"{label} 圖片必須介於 1 byte 與 5 MB 之間")
        variants.append({"label": label, "content": content, "width": width, "height": height})
    return variants


async def _library(ctx: Ctx) -> dict:
    """One page of the library as the browser asked for it.

    Three routes answer with it — the list itself, and the two that change it
    and hand back what the grid should now show. Rebuilding the query in each
    is how one of them ends up on a different page from the others.
    """

    page, per_page = paging.clamp(
        (ctx.query.get("page") or [""])[0],
        (ctx.query.get("perPage") or [""])[0],
        default_per_page=media.PER_PAGE,
    )
    items, total = await media.list_media(
        ctx.env, search=(ctx.query.get("q") or [""])[0], page=page, per_page=per_page
    )
    return {"media": items, **paging.envelope(items, total, page, per_page)}


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/media" and method == "GET":
        return ctx.json(await _library(ctx))

    # Before the /api/media/{id} block below, which would read "tags" as an id
    # and refuse it. Same rule as the order and category routes.
    if path == "/api/media/tags" and method == "GET":
        return ctx.json({"tags": await media.list_tags(env)})

    # Both of these sit before the /api/media/{id} block, which would read
    # "usage" and "delete" as ids — they are the right length and shape — and
    # answer 404 for something that is not an image at all. Same rule as the
    # tag route above, and as the order and category routes.
    if path == "/api/media/usage" and method == "GET":
        # Asked before a bulk delete is confirmed, so the one dialog can say
        # which of the selected images a page is still using. One scan over
        # every block answers for the whole selection.
        try:
            wanted = media.validate_ids((ctx.query.get("ids") or [""])[0].split(","))
        except media.MediaError as error:
            return ctx.error(str(error), 400)
        return ctx.json({"usage": await media.usage_of(env, wanted)})

    if path == "/api/media/delete" and method == "POST":
        try:
            body = await ctx.json_body()
            wanted = media.validate_ids(body.get("ids"))
        except media.MediaError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid media", 400)

        # The same two-step as the single delete: the answer says what is in
        # use, and deleting it anyway takes a second ask. Checked for the
        # whole selection at once so that one image in use does not have to be
        # discovered halfway through deleting the other nine.
        used = {
            media_id: pages for media_id, pages in (await media.usage_of(env, wanted)).items() if pages
        }
        if used and not body.get("force"):
            return ctx.json({"error": "選取的圖片還被頁面使用中", "usage": used}, 409)

        # One image failing must not take the other nine down with it, and it
        # must not be reported as deleted either. The old loop raised on the
        # first failure, so the browser saw a 500, said nothing was deleted,
        # and the rows that had already gone came back missing on reload.
        deleted, failed = 0, []
        for media_id in wanted:
            try:
                keys = await media.delete(env, media_id)
            except Exception:
                failed.append(media_id)
                continue
            if keys is None:
                # Already gone — two tabs open on the same library. Nothing
                # failed, so it is not reported as a failure.
                continue
            deleted += 1
            for key in keys:
                try:
                    await env.IBON_IMAGES.delete(key)
                except Exception:
                    # The row is gone; the file is orphaned in the bucket. The
                    # image is deleted as far as anyone using the shop can
                    # tell, and telling the owner otherwise helps nobody.
                    pass
        return ctx.json({**await _library(ctx), "deleted": deleted, "failed": failed})

    if path == "/api/media" and method == "POST":
        try:
            form = await ctx.request.form_data()
            uploaded = form.get("file")
            if uploaded is None:
                raise media.MediaError("缺少檔案")
            file_name = media.clean_file_name(uploaded.name)
            suffix = media.validate_image_suffix(file_name)
            title = media.validate_title(await _form_text(form, "title"))
            alt = media.validate_alt(await _form_text(form, "alt"))
            width, height = media.validate_dimensions(await _form_text(form, "dimensions"))
            content = await uploaded.bytes()
            if not content or len(content) > media.MAX_IMAGE_BYTES:
                raise media.MediaError("圖片必須介於 1 byte 與 5 MB 之間")
            variants = await _read_variants(form)
            if not width:
                variants = []
        except media.MediaError as error:
            return ctx.error(str(error), 400)
        except (ValueError, AttributeError):
            return ctx.error("Invalid upload", 400)

        # The objects first: a row pointing at nothing is an image the library
        # offers and the site cannot draw. An object with no row is only
        # storage, and the next upload does not trip over it.
        key = media.object_key(suffix)
        await env.IBON_IMAGES.put(key, content)
        sizes = []
        for variant in variants:
            variant_key = media.variant_key(variant["label"])
            await env.IBON_IMAGES.put(variant_key, variant["content"])
            sizes.append(
                {
                    "label": variant["label"],
                    "object_key": variant_key,
                    "width": variant["width"],
                    "height": variant["height"],
                    "byte_size": len(variant["content"]),
                }
            )
        row = await media.create(
            env,
            object_key=key,
            file_name=file_name,
            title=title,
            alt=alt,
            byte_size=len(content),
            width=width,
            height=height,
            sizes=sizes,
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
                body = await ctx.json_body()
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
            keys = await media.delete(env, media_id)
            if keys is None:
                return ctx.error("Media not found", 404)
            # Every width, not only the original: a variant left in the bucket
            # is storage that nothing can reach again.
            for key in keys:
                await env.IBON_IMAGES.delete(key)
            # The list comes back filtered the same way it was asked for, so
            # deleting from a search does not silently drop the search.
            return ctx.json(await _library(ctx))

    return ctx.error("Not found", 404)
