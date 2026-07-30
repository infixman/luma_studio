"""Stock, courses and what an Offer delivers.

`admin_main.dispatch` has already established that the caller is signed in, so
nothing here repeats that check. What it does do is refuse anything the server
is supposed to work out for itself: an Offer's components decide whether it
needs posting, so a request that also states `requiresShipping` is describing
a fact it does not own, and is rejected rather than ignored. Ignoring it would
let the client keep believing it had been obeyed.
"""

from domain import courses, inventory, offers, shop, video
from shared import sanitize
from shared.common import validate_choice, validate_text
from shared.responses import Ctx


# Fields the server derives. Present in a request, they are a caller trying to
# decide something that is not theirs to decide.
DERIVED_FIELDS = ("requiresShipping", "containsCourse", "digitalOnly", "isBundle")


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

        if action == "archive" and method == "POST":
            # A published lesson pointing at an archived video surfaces as a
            # member unable to watch, which is a worse way to find out than an
            # admin action being refused.
            lessons = await video.lessons_using(env, asset_id)
            if lessons:
                names = "、".join(lesson["title"] for lesson in lessons[:3])
                return ctx.error(f"這支影片正被單元「{names}」使用，請先替換影片", 409)
            if not await video.archive_asset(env, asset_id):
                return ctx.error("這支影片目前的狀態不能封存", 409)
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
