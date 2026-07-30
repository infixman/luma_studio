"""Stock, courses and what an Offer delivers.

`admin_main.dispatch` has already established that the caller is signed in, so
nothing here repeats that check. What it does do is refuse anything the server
is supposed to work out for itself: an Offer's components decide whether it
needs posting, so a request that also states `requiresShipping` is describing
a fact it does not own, and is rejected rather than ignored. Ignoring it would
let the client keep believing it had been obeyed.
"""

from domain import courses, inventory, offers, shop, source_upload, video, video_storage
from shared import flags, r2_s3, sanitize
from shared.common import validate_choice, validate_text
from shared.responses import Ctx


# Fields the server derives. Present in a request, they are a caller trying to
# decide something that is not theirs to decide.
DERIVED_FIELDS = ("requiresShipping", "containsCourse", "digitalOnly", "isBundle")

# Re-encoding an asset a thousand times is not a workflow. The bound is here so
# a version number arriving in a request cannot become an unbounded integer in
# an object key.
MAX_VERSION = 999


def _optional_int(value) -> int | None:
    """A number the tool measured, or nothing.

    Absent is normal — a source with no readable duration is still a file worth
    uploading. Present but not a number is a bug in the caller, and refusing it
    beats storing a string in an integer column or, worse, dropping it and
    letting the caller believe it was recorded.

    `bool` is excluded on purpose: `isinstance(True, int)` is true, so a naive
    check stores `width=True` as a width of 1.
    """

    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("影片長度與尺寸必須是整數")
    return value


def _upload_version(body: dict, kind) -> int:
    """Which version the keys in this request must sit under.

    An original has one version and the encodes have many, so they are named
    separately — a request that says `encodeVersion` while uploading a source
    is describing something that does not exist.
    """

    field = "uploadVersion" if kind == "source" else "encodeVersion"
    value = body.get(field, 1)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_VERSION:
        raise ValueError(f"{field} 必須是 1 到 {MAX_VERSION} 之間的整數")
    return value


def _measurements(body: dict) -> dict:
    """What ffprobe read from the source.

    For display and for choosing the ladder. Nothing about whether an encode is
    playable is decided from these — that is settled by verifying objects — so
    they are all optional.
    """

    return {
        "duration_seconds": _optional_int(body.get("durationSeconds")),
        "width": _optional_int(body.get("width")),
        "height": _optional_int(body.get("height")),
    }


def _item_fields(body: dict) -> dict:
    return {
        "title": inventory.validate_title(body.get("title")),
        "sku": inventory.validate_sku(body.get("sku")),
        "stock": inventory.validate_stock(body.get("stock", 0)),
        "enabled": bool(body.get("enabled", True)),
    }


def _course_fields(body: dict) -> dict:
    """The fields a course create or update may set.

    `status` is here because creating a draft is the normal case; publishing
    is its own route, because it has checks a plain save must not run.
    """

    return {
        "slug": courses.validate_slug(body.get("slug")),
        "title": courses.validate_title(body.get("title")),
        "status": courses.validate_status(body.get("status") or "draft"),
    }


def _course_display_fields(body: dict) -> dict:
    """The parts a product page reads. All optional while writing.

    Publishing is where their absence becomes a problem, so an author can
    save a half-written course without being nagged for the rest of it.
    """

    def html(name: str, label: str) -> str:
        # Cleaned here, on the way in. The editor limits what an author can
        # type; this is the boundary, and content arriving by any other route
        # goes through the same door.
        raw = validate_text(body.get(name) or "", courses.MAX_HTML, label, required=False)
        return sanitize.sanitize_html(raw) if raw else ""

    cover = str(body.get("coverMediaId") or "").strip() or None
    return {
        "summary": validate_text(body.get("summary") or "", courses.MAX_SUMMARY, "課程簡介", required=False),
        "instructorName": validate_text(body.get("instructorName") or "", 60, "講師", required=False),
        "level": validate_choice(body.get("level") or "all", courses.LEVELS, "難度"),
        "language": validate_text(body.get("language") or "zh-Hant", 20, "語言", required=False),
        "coverMediaId": cover,
        "descriptionHtml": html("descriptionHtml", "課程介紹"),
        "instructorBioHtml": html("instructorBioHtml", "講師介紹"),
        "audienceHtml": html("audienceHtml", "適合對象"),
        "outcomesHtml": html("outcomesHtml", "學習成果"),
        "prerequisitesHtml": html("prerequisitesHtml", "先備知識"),
        "materialsHtml": html("materialsHtml", "工具與材料"),
    }


async def _component_view(ctx: Ctx, offer_id: str) -> dict:
    """Components plus what the server makes of them.

    The editor shows "grants access, needs posting" from this rather than
    working it out again, so there is one answer rather than two.

    The raw components are read separately even though `resolve_offer` has
    already been through them, and that second query is deliberate.
    `resolve_offer` *drops* a component whose target was archived, because a
    cart must not quote something it cannot deliver. The editor needs the
    opposite: it is the screen where that broken component gets removed, and
    it cannot remove one it was never shown.
    """

    resolved = await offers.resolve_offer(ctx.env, offer_id, 1)
    return {
        "components": await offers.list_components(ctx.env, offer_id),
        "capabilities": {
            "containsCourse": resolved["containsCourse"],
            "requiresShipping": resolved["requiresShipping"],
            "digitalOnly": resolved["digitalOnly"],
            "isBundle": resolved["isBundle"],
        },
        "blockers": offers.sale_blockers(resolved),
    }


async def handle(ctx: Ctx):
    env, path, method = ctx.env, ctx.path, ctx.method

    if path == "/api/inventory-items" and method == "GET":
        return ctx.json(
            {
                "items": await inventory.list_items(
                    env,
                    search=(ctx.query.get("q") or [""])[0].strip(),
                    enabled_only=(ctx.query.get("enabled") or [""])[0] == "1",
                )
            }
        )

    if path == "/api/inventory-items" and method == "POST":
        try:
            fields = _item_fields(await ctx.json_body())
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid item", 400)
        if await inventory.sku_taken(env, fields["sku"]):
            return ctx.error("另一個庫存品已經使用這個貨號", 409)
        item_id = await inventory.create_item(env, **fields)
        return ctx.json({"item": await inventory.get_item(env, item_id)}, 201)

    if path.startswith("/api/inventory-items/"):
        tail = path[len("/api/inventory-items/") :]
        item_id, _, action = tail.partition("/")
        item = await inventory.get_item(env, item_id)
        if item is None:
            return ctx.error("Item not found", 404)

        if not action and method == "GET":
            return ctx.json({"item": item})

        if action == "references" and method == "GET":
            return ctx.json({"offerIds": await offers.references_of(env, "inventory", item_id)})

        if action == "history" and method == "GET":
            return ctx.json({"adjustments": await inventory.adjustment_history(env, item_id)})

        if not action and method == "PUT":
            try:
                fields = _item_fields(await ctx.json_body())
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid item", 400)
            if await inventory.sku_taken(env, fields["sku"], excluding=item_id):
                return ctx.error("另一個庫存品已經使用這個貨號", 409)
            # The row was read, then written, and the write refuses an item
            # archived in between. Answering 200 with the values that were
            # read would tell the admin their edit landed when it did not.
            # Stock is a claim about the world, so it goes through the
            # adjustment path with a name on it rather than being overwritten
            # silently along with the title.
            if fields["stock"] != item["stock"]:
                await inventory.adjust_stock(
                    env, item_id, fields["stock"], actor=ctx.admin_email, reason="庫存品編輯"
                )
            if not await inventory.update_item(env, item_id, **fields):
                return ctx.error("這個庫存品已被封存，請重新整理", 409)
            return ctx.json({"item": await inventory.get_item(env, item_id)})

        if action == "archive" and method == "POST":
            await inventory.archive_item(env, item_id)
            return ctx.json({"item": await inventory.get_item(env, item_id)})

        if not action and method == "DELETE":
            # Order fulfilment snapshots and offer components name this row.
            # Deleting it would leave both pointing at nothing, and an order
            # that cannot say what it was for is worse than a stale row.
            references = await offers.references_of(env, "inventory", item_id)
            if references:
                return ctx.error(
                    f"這個庫存品正被 {len(references)} 個銷售方案使用，請改為封存", 409
                )
            await inventory.archive_item(env, item_id)
            # The same shape as the archive route, and the truth either way:
            # an item that was already archived is still archived. Reporting
            # a boolean the caller cannot check would be worse than useless.
            return ctx.json({"item": await inventory.get_item(env, item_id)})

        return ctx.error("Not found", 404)

    if path == "/api/video-assets" and method == "GET":
        return ctx.json(
            {"assets": await video.list_assets(env, status=(ctx.query.get("status") or [""])[0] or None)}
        )

    if path == "/api/video-assets" and method == "POST":
        if not flags.enabled(env, flags.VIDEO_UPLOAD):
            return ctx.error("影片上傳尚未開放", 403)
        try:
            body = await ctx.json_body()
            asset_id = await video.create_asset(
                env,
                title=validate_text(body.get("title"), 200, "影片名稱"),
                original_filename=validate_text(
                    body.get("originalFilename") or "", 200, "原始檔名", required=False
                ),
                # The ceiling is checked inside `create_asset`, which owns it.
                byte_size=body.get("byteSize"),
                **_measurements(body),
            )
        except (ValueError, AttributeError, TypeError) as error:
            return ctx.error(str(error) or "Invalid video", 400)

        # The version numbers are the tool's next question, and it would
        # otherwise have to know that a first upload is version 1.
        return ctx.json(
            {"asset": await video.get_asset(env, asset_id), "uploadVersion": 1, "encodeVersion": 1},
            201,
        )

    if path == "/api/video-assets/import" and method == "POST":
        if not flags.enabled(env, flags.VIDEO_UPLOAD):
            return ctx.error("影片上傳尚未開放", 403)
        # The ladder is transcoded and uploaded elsewhere, so nothing about it
        # is taken on trust here. One dropped object out of several hundred is
        # ordinary, and the video plays fine until it reaches that object.
        try:
            body = await ctx.json_body()
            title = validate_text(body.get("title"), 200, "影片名稱")
            filename = validate_text(body.get("originalFilename") or "", 200, "原始檔名", required=False)
            version = int(body.get("encodeVersion") or 1)
            measured = _measurements(body)
        except (ValueError, AttributeError, TypeError) as error:
            return ctx.error(str(error) or "Invalid import", 400)

        asset_id = str(body.get("assetId") or "").strip()
        if asset_id:
            # Re-verifying an upload that was fixed and synced again.
            existing = await video.get_asset(env, asset_id)
            if existing is None:
                return ctx.error("Video not found", 404)
            # Registering writes straight to `ready`, bypassing the state
            # machine, so nothing else here would stop an abandoned upload from
            # coming back. And it would: abandoning changes a row, while the tool
            # holding presigned URLs keeps going, finishes, and calls import with
            # the same id. An admin's decision to retire a video has to outlast
            # whatever the tool does next.
            if existing["status"] in video.RETIRED:
                return ctx.error("這支影片已經封存或放棄，請重新建立一支", 409)
        else:
            asset_id = video.urlsafe_token(18)

        verified = await video.verify_encode(env.COURSE_VIDEO, asset_id, version)
        if not verified["ok"]:
            # Everything missing, not the first thing: re-running one sync is a
            # better afternoon than re-running six.
            return ctx.json(
                {
                    "error": f"這個版本還缺 {len(verified['missing'])} 個檔案",
                    "missing": verified["missing"][:20],
                    "assetId": asset_id,
                },
                409,
            )

        # Before the asset row, and the order matters because these are two
        # statements with nothing joining them. If the second one fails, this
        # order leaves a version row that nothing live points at — a storage
        # total overstated by one encode, corrected by the next import. The other
        # order leaves a `ready` asset whose active version no row describes,
        # which is precisely what the orphan scan reads as "these objects belong
        # to nobody" — about objects a member is watching.
        await video.record_encode_version(
            env,
            asset_id=asset_id,
            encode_version=version,
            object_count=verified["objectCount"],
            byte_size=verified["byteSize"],
            has_poster=verified["hasPoster"],
        )
        created = await video.register_verified_asset(
            env,
            asset_id=asset_id,
            title=title,
            original_filename=filename,
            **measured,
            encode_version=version,
            # Only if it is actually there. `verify_encode` looked, because no
            # playlist points at it and walking the manifest never reaches it.
            poster=video.poster_key(asset_id, version) if verified["hasPoster"] else None,
        )
        return ctx.json({"asset": await video.get_asset(env, created), "objectCount": verified["objectCount"]}, 201)

    if path.startswith("/api/video-assets/"):
        tail = path[len("/api/video-assets/") :]
        asset_id, _, action = tail.partition("/")
        asset = await video.get_asset(env, asset_id)
        if asset is None:
            return ctx.error("Video not found", 404)

        if not action and method == "GET":
            return ctx.json({"asset": asset})

        if action == "references" and method == "GET":
            return ctx.json({"lessons": await video.lessons_using(env, asset_id)})

        # The original file's own upload. A pending multipart upload is state R2
        # holds for us — parts already sent are billed and invisible in a listing
        # — so opening one is a request to the Worker with a row behind it, not a
        # URL the tool is handed. Only the parts are presigned.
        if action == "source-upload" and method == "POST":
            if not flags.enabled(env, flags.VIDEO_UPLOAD):
                return ctx.error("影片上傳尚未開放", 403)
            try:
                return ctx.json(await source_upload.start(env, asset=asset), 201)
            except video_storage.NotConfigured:
                return ctx.error("影片上傳尚未設定完成", 503)
            except r2_s3.R2Error:
                # Not the caller's fault and not something a retry of the same
                # request will fix in the next second. The message stays ours:
                # R2's carries an error code and nothing an admin can act on.
                return ctx.error("R2 目前無法開始上傳，請稍後再試", 502)
            except ValueError as error:
                return ctx.error(str(error) or "Invalid upload", 409)

        if action.startswith("source-upload/") and method == "POST":
            if not flags.enabled(env, flags.VIDEO_UPLOAD):
                return ctx.error("影片上傳尚未開放", 403)
            # `{sessionId}/{step}/{rest}`, split once so the steps below read as
            # cases rather than as string surgery.
            session_id, step, rest = (action[len("source-upload/") :].split("/", 2) + ["", ""])[:3]
            session = await source_upload.get_session(env, session_id, asset_id=asset_id)
            if session is None:
                return ctx.error("Upload session not found", 404)

            if step == "parts" and rest:
                # The session's own state first, and with its own status: "this
                # upload already ended" is a different answer from "that is not a
                # part number", and a caller cannot tell them apart from a 400.
                # `part_url` refuses it too — that copy is the domain keeping its
                # invariant, this one is for the status code.
                try:
                    source_upload.usable(session, video.utc_timestamp())
                except ValueError as error:
                    return ctx.error(str(error), 409)
                try:
                    # `int` accepts "+1", " 1" and unicode digits; the path
                    # segment either is digits or it is not a part number.
                    part_number = int(rest) if rest.isascii() and rest.isdigit() else -1
                    return ctx.json(
                        source_upload.part_url(
                            env, asset=asset, session=session, part_number=part_number
                        )
                    )
                except video_storage.NotConfigured:
                    return ctx.error("影片上傳尚未設定完成", 503)
                except ValueError as error:
                    return ctx.error(str(error) or "Invalid part", 400)

            if step in ("complete", "abort") and not rest:
                parts = None
                if step == "complete":
                    try:
                        parts = (await ctx.json_body()).get("parts")
                    except (AttributeError, TypeError, ValueError):
                        return ctx.error("Invalid request", 400)
                try:
                    if step == "abort":
                        await source_upload.abort(env, session=session)
                        return ctx.json({"status": "aborted"})
                    finished = await source_upload.complete(
                        env, asset=asset, session=session, parts=parts
                    )
                    return ctx.json({"status": "completed", **finished})
                except video_storage.NotConfigured:
                    return ctx.error("影片上傳尚未設定完成", 503)
                except r2_s3.R2Error:
                    # The upload is not finished and this request cannot say more
                    # than that. Retrying is safe — both steps are idempotent —
                    # which is why this is not a 4xx.
                    return ctx.error("R2 目前無法完成這個動作，請稍後再試", 502)
                except source_upload.InvalidParts as error:
                    # The request's shape, not the upload's state. Answering 409
                    # to both would tell a tool with a malformed body to go and
                    # look at something that is not wrong.
                    return ctx.error(str(error), 400)
                except ValueError as error:
                    return ctx.error(str(error) or "Invalid request", 409)
                except AttributeError:
                    # A binding this deployment does not have — `COURSE_SOURCE`
                    # is read only on this path. Not the caller's fault, and not
                    # a conflict to resolve.
                    return ctx.error("影片上傳尚未設定完成", 503)

            return ctx.error("Not found", 404)

        if action == "upload-urls" and method == "POST":
            if not flags.enabled(env, flags.VIDEO_UPLOAD):
                return ctx.error("影片上傳尚未開放", 403)
            # Before anything is signed, and with its own status, because "this
            # video is finished" is a different answer from "your request was
            # malformed". `upload_urls` refuses it too; that copy is the domain
            # keeping its own invariant, this one is for the status code.
            if asset["status"] != "uploading":
                return ctx.error("這支影片已經不在上傳中", 409)
            try:
                body = await ctx.json_body()
                kind = body.get("kind")
                # The version the keys must sit under. Taken from the request
                # because a re-upload and a re-encode both name their own, and
                # bounded rather than trusted — the keys are then checked
                # against exactly this number, so the worst a wrong one does is
                # write into an unused corner of the caller's own asset.
                version = _upload_version(body, kind)
                granted = video_storage.upload_urls(
                    env, asset=asset, keys=body.get("keys"), kind=kind, version=version
                )
            except video_storage.NotConfigured:
                # Not the caller's fault, and not something to paper over with
                # an unsigned URL that looks signed.
                return ctx.error("影片上傳尚未設定完成", 503)
            except ValueError as error:
                # Never the URL, and never the key that was refused: an error
                # body is the one place nobody reads carefully.
                return ctx.error(str(error) or "Invalid upload request", 400)
            except (AttributeError, TypeError):
                return ctx.error("Invalid upload request", 400)

            return ctx.json({"urls": granted})

        # Two ways out of use, and the same guard in front of both. `archive` is
        # for a video that was something; `abort` is for an upload that never
        # became one — an asset the tool created and never finished has no other
        # exit, because only `ready` and `failed` reach `archived`.
        #
        # One branch rather than two, because the guard in front of them is the
        # part that must not differ: a lesson pointing at a retired video
        # surfaces as a member unable to watch, which is a worse way to find out
        # than an admin action being refused.
        if action in ("archive", "abort") and method == "POST":
            to_status = "archived" if action == "archive" else "aborted"
            refused = (
                "這支影片目前的狀態不能封存"
                if action == "archive"
                else "這支影片目前的狀態不能放棄上傳"
            )
            lessons = await video.lessons_using(env, asset_id)
            if lessons:
                names = "、".join(lesson["title"] for lesson in lessons[:3])
                return ctx.error(f"這支影片正被單元「{names}」使用，請先替換影片", 409)
            if not await video.retire_asset(env, asset_id, to_status):
                return ctx.error(refused, 409)
            return ctx.json({"asset": await video.get_asset(env, asset_id)})

        return ctx.error("Not found", 404)

    if path == "/api/courses" and method == "GET":
        return ctx.json({"courses": await courses.list_courses(env, status=(ctx.query.get("status") or [""])[0] or None)})

    if path == "/api/courses" and method == "POST":
        try:
            fields = _course_fields(await ctx.json_body())
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid course", 400)
        if await courses.slug_taken(env, fields["slug"]):
            return ctx.error("另一門課程已經使用這個網址代稱", 409)
        course_id = await courses.create_course(env, **fields)
        return ctx.json({"course": await courses.get_course(env, course_id)}, 201)

    if path.startswith("/api/courses/"):
        tail = path[len("/api/courses/") :]
        course_id, _, action = tail.partition("/")
        course = await courses.get_course(env, course_id)
        if course is None:
            return ctx.error("Course not found", 404)

        if action == "outline" and method == "GET":
            return ctx.json({"sections": await courses.get_outline(env, course_id)})

        if action == "outline" and method == "PUT":
            try:
                # The whole tree, checked before anything is deleted. A bad
                # request must not cost the author the outline they had.
                sections = courses.validate_outline((await ctx.json_body()).get("sections"))
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid outline", 400)
            await courses.replace_outline(env, course_id, sections)
            return ctx.json({"sections": await courses.get_outline(env, course_id)})

        if action == "publish" and method == "POST":
            outline = await courses.get_outline(env, course_id)
            ready = await courses.ready_video_asset_ids(env, outline)
            problems = courses.publish_problems(course, outline, ready_asset_ids=ready)
            if problems:
                # Everything at once: fixing one per attempt is a bad afternoon.
                return ctx.json({"error": "課程尚未符合發布條件", "problems": problems}, 409)
            await courses.publish(env, course_id)
            return ctx.json({"course": await courses.get_course(env, course_id)})

        if action == "archive" and method == "POST":
            # Archiving stops new sales and new grants. It deliberately does
            # not touch anybody's existing access.
            await courses.update_status(env, course_id, "archived")
            return ctx.json({"course": await courses.get_course(env, course_id)})

        if action:
            return ctx.error("Not found", 404)

        if method == "GET":
            return ctx.json({"course": course})

        if method == "PUT":
            try:
                fields = _course_fields(await ctx.json_body())
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid course", 400)
            if await courses.slug_taken(env, fields["slug"], excluding=course_id):
                return ctx.error("另一門課程已經使用這個網址代稱", 409)
            try:
                display = _course_display_fields(await ctx.json_body())
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid course", 400)
            if not await courses.update_course(env, course_id, **fields, **display):
                return ctx.error("Course not found", 404)
            return ctx.json({"course": await courses.get_course(env, course_id)})

        return ctx.error("Not found", 404)

    if path.startswith("/api/offers/") and path.endswith("/components"):
        offer_id = path[len("/api/offers/") : -len("/components")]
        if await shop.get_variant(env, offer_id) is None:
            return ctx.error("Offer not found", 404)

        if method == "GET":
            return ctx.json(await _component_view(ctx, offer_id))

        if method == "PUT":
            try:
                body = await ctx.json_body()
                present = [field for field in DERIVED_FIELDS if field in body]
                if present:
                    raise ValueError(f"這些欄位由伺服器決定，不接受提交：{', '.join(present)}")
                # The whole set is validated before any of it is written. An
                # offer left holding the course but not the kit is worse than
                # one that refused to save.
                components = offers.validate_components(body.get("components"))
                await offers.validate_targets(env, components)
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid components", 400)
            await offers.replace_components(env, offer_id, components)
            return ctx.json(await _component_view(ctx, offer_id))

        return ctx.error("Not found", 404)

    return ctx.error("Not found", 404)
