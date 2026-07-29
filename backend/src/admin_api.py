"""R2/D1 management endpoints on the admin deployment.

The paths carry no `/api/admin` prefix because every route on
admin-api.luma-studio.tw is administration; `admin_main.dispatch` has already
established that the caller is signed in before anything here runs.
"""

from shared.common import (
    DEFAULT_PRINT_SELECT_TYPE,
    IDENTIFIER_PATTERN,
    IMAGE_SUFFIXES,
    MAX_FILE_COUNT,
    MAX_TOTAL_BYTES,
    d1_rows,
    utc_timestamp,
    validate_file_name,
    validate_folder,
)
from ibon import get_folder_select_type, invalidate_print_cache, print_spec, validate_select_type
from shared.responses import Ctx


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/print-settings" and method == "GET":
        try:
            folder = validate_folder((ctx.query.get("folder") or [""])[0])
        except ValueError:
            return ctx.error("Invalid folder id", 400)
        select_type = await get_folder_select_type(env, folder)
        return ctx.json({"folder": folder, "selectType": select_type, "printSpec": print_spec(select_type)})

    if path == "/api/print-settings" and method == "PUT":
        try:
            body = await ctx.request.json()
            folder = validate_folder(str(body.get("folder") or ""))
            select_type = validate_select_type(str(body.get("selectType") or ""))
        except (ValueError, AttributeError):
            return ctx.error("Invalid print setting", 400)
        existing = await d1_rows(env.DB.prepare("SELECT select_type FROM folder_print_settings WHERE folder_id = ?1").bind(folder))
        changed = not existing or existing[0]["select_type"] != select_type
        await env.DB.prepare("""INSERT INTO folder_print_settings (folder_id, select_type, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(folder_id) DO UPDATE SET select_type = excluded.select_type, updated_at = excluded.updated_at""").bind(folder, select_type, utc_timestamp()).run()
        if changed:
            await invalidate_print_cache(env, folder)
        return ctx.json({"folder": folder, "selectType": select_type, "printSpec": print_spec(select_type), "cacheInvalidated": changed})

    if path == "/api/folders" and method == "GET":
        listing = await env.IBON_IMAGES.list(delimiter="/", limit=1000)
        folders = sorted(prefix.rstrip("/") for prefix in listing.delimitedPrefixes if IDENTIFIER_PATTERN.fullmatch(prefix.rstrip("/")))
        return ctx.json({"folders": folders, "truncated": bool(listing.truncated)})

    if path == "/api/folders" and method == "POST":
        try:
            folder = validate_folder(str((await ctx.request.json()).get("folder") or ""))
        except (ValueError, AttributeError):
            return ctx.error("Invalid folder id", 400)
        await env.IBON_IMAGES.put(f"{folder}/.keep", "")
        await env.DB.prepare("INSERT OR IGNORE INTO folder_print_settings (folder_id, select_type, updated_at) VALUES (?1, ?2, ?3)").bind(folder, DEFAULT_PRINT_SELECT_TYPE, utc_timestamp()).run()
        await invalidate_print_cache(env, folder)
        return ctx.json({"folder": folder}, 201)

    if path.startswith("/api/folders/") and method == "DELETE":
        try:
            folder = validate_folder(path.removeprefix("/api/folders/"))
        except ValueError:
            return ctx.error("Invalid folder id", 400)
        listing = await env.IBON_IMAGES.list(prefix=f"{folder}/", limit=1000)
        if listing.truncated or any(item.key != f"{folder}/.keep" for item in listing.objects):
            return ctx.error("Delete the folder's images first", 409)
        await env.IBON_IMAGES.delete(f"{folder}/.keep")
        await env.DB.prepare("DELETE FROM folder_print_settings WHERE folder_id = ?1").bind(folder).run()
        await invalidate_print_cache(env, folder)
        return ctx.json({"folder": folder, "deleted": True})

    if path == "/api/objects" and method == "GET":
        try:
            folder = validate_folder((ctx.query.get("folder") or [""])[0])
        except ValueError:
            return ctx.error("Invalid folder id", 400)
        listing = await env.IBON_IMAGES.list(prefix=f"{folder}/", limit=1000)
        objects = [{"key": item.key, "name": item.key.split("/")[-1], "size": item.size} for item in listing.objects if item.key != f"{folder}/.keep" and any(item.key.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES)]
        return ctx.json({"folder": folder, "objects": objects, "truncated": bool(listing.truncated)})

    if path == "/api/upload" and method == "POST":
        try:
            form = await ctx.request.form_data()
            folder = validate_folder(str(form.get("folder") or ""))
            uploaded_file = form.get("file")
            if uploaded_file is None:
                raise ValueError("Missing multipart file field")
            file_name = validate_file_name(str(uploaded_file.name))
            file_content = await uploaded_file.bytes()
            if not file_content or len(file_content) > MAX_TOTAL_BYTES:
                raise ValueError("Image must be between 1 byte and 15 MB")
        except ValueError as error:
            return ctx.error(str(error) or "Invalid upload", 400)
        except AttributeError:
            return ctx.error("Invalid multipart file field", 400)
        existing = await env.IBON_IMAGES.list(prefix=f"{folder}/", limit=1000)
        image_objects = [item for item in existing.objects if any(item.key.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES)]
        existing_keys = [item.key for item in image_objects]
        image_count = len(image_objects)
        key = f"{folder}/{file_name}"
        replaced_size = next((item.size for item in image_objects if item.key == key), 0)
        if existing.truncated or (image_count >= MAX_FILE_COUNT and key not in existing_keys):
            return ctx.error(f"A folder can contain at most {MAX_FILE_COUNT} images", 409)
        if sum(item.size for item in image_objects) - replaced_size + len(file_content) > MAX_TOTAL_BYTES:
            return ctx.error("Images in a folder must total 15 MB or less", 409)
        await env.IBON_IMAGES.put(key, file_content)
        await invalidate_print_cache(env, folder)
        return ctx.json({"key": key}, 201)

    if path == "/api/objects" and method == "DELETE":
        key = (ctx.query.get("key") or [""])[0]
        folder, separator, file_name = key.partition("/")
        try:
            validate_folder(folder)
            if not separator:
                raise ValueError()
            validate_file_name(file_name)
        except ValueError:
            return ctx.error("Invalid object key", 400)
        await env.IBON_IMAGES.delete(key)
        await invalidate_print_cache(env, folder)
        return ctx.json({"key": key, "deleted": True})

    return ctx.error("Unknown admin endpoint", 404)
