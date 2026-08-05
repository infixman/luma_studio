"""What a member can reach, and what everybody else cannot.

Every answer here is about the customer in the session. Nothing takes a
customer id as an argument from a request — a request that names one is a
request to read somebody else's courses.

Whether a lesson may be played is decided in one place, `playable`, because
the answer feeds two different things: what the learning page shows, and
whether a playback token gets minted. Two implementations of "may they watch"
would eventually disagree, and the disagreement would be silent in one
direction and embarrassing in the other.
"""

from domain import entitlements, media
from shared.common import d1_rows, utc_timestamp


# Not a limit on how long a lesson may be. It is the point past which a
# reported position is a broken client rather than somebody watching.
MAX_POSITION_SECONDS = 24 * 60 * 60


async def _lesson(env, lesson_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM course_lessons WHERE id = ?1").bind(lesson_id))
    return rows[0] if rows else None


async def _course_of_lesson(env, section_id: str) -> dict | None:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT c.* FROM courses c JOIN course_sections s ON s.course_id = c.id WHERE s.id = ?1"
        ).bind(section_id)
    )
    return rows[0] if rows else None


async def playable(env, *, customer_id: str | None, lesson_id: str) -> dict:
    """Whether this lesson can be played, and what it would play.

    Refusals carry a reason because they mean different things to the person
    reading them: "you have not bought this" and "this is still encoding" want
    different buttons underneath.

    A preview lesson is open to anybody, including somebody with no account —
    trying before buying is the point of one. It still goes through the same
    gateway with the same short-lived token; being free to watch is not the
    same as being free to download.
    """

    lesson = await _lesson(env, lesson_id)
    if lesson is None:
        return {"allowed": False, "reason": "not_found"}

    course = await _course_of_lesson(env, lesson["section_id"])
    if course is None:
        return {"allowed": False, "reason": "not_found"}

    # Access is settled before anything about the video is. A text-only lesson
    # used to answer "no video" to everybody, including somebody who had not
    # bought the course — and that answer is treated as harmless further up,
    # which turned a reading into a hole.
    is_preview = bool(lesson["is_preview"])
    entitlement = None
    if not is_preview:
        if customer_id is None:
            return {"allowed": False, "reason": "not_entitled", "courseId": course["id"]}
        entitlement = await entitlements.get_entitlement(env, customer_id, course["id"])
        if entitlement is None:
            return {"allowed": False, "reason": "not_entitled", "courseId": course["id"]}
        if not entitlements.is_active(entitlement, now=utc_timestamp()):
            # Told apart on purpose: a window that ran out can be bought
            # again, and a revoked one is a conversation with the shop.
            reason = "revoked" if entitlement["revokedAt"] is not None else "expired"
            return {"allowed": False, "reason": reason, "courseId": course["id"]}

    if not lesson["video_asset_id"]:
        # A reading, and one this member is allowed to have. The course id
        # comes back so progress can be recorded against the course the lesson
        # is actually in rather than whichever one the request claimed.
        return {"allowed": False, "reason": "no_video", "courseId": course["id"], "lessonId": lesson["id"]}

    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM video_assets WHERE id = ?1").bind(lesson["video_asset_id"])
    )
    asset = rows[0] if rows else None
    if asset is None or asset["status"] != "ready" or asset["active_encode_version"] is None:
        # A clear "not yet" beats a player failing on a 404 it cannot explain.
        return {"allowed": False, "reason": "not_ready", "courseId": course["id"]}

    return {
        "allowed": True,
        "scope": "preview" if is_preview else "entitled",
        "courseId": course["id"],
        "lessonId": lesson["id"],
        "assetId": asset["id"],
        "encodeVersion": int(asset["active_encode_version"]),
        "entitlementId": entitlement["id"] if entitlement else None,
        "accessDays": entitlement["accessDays"] if entitlement else None,
        "firstViewedAt": entitlement["firstViewedAt"] if entitlement else None,
    }


async def save_progress(
    env,
    *,
    customer_id: str,
    course_id: str,
    lesson_id: str,
    position_seconds,
    completed: bool,
) -> None:
    """Remember where somebody got to.

    Written as an upsert keyed on the member and the lesson, so the answer to
    "where was I" stays single-valued however many devices are reporting.

    `completed_at` is only ever set, never cleared: scrubbing back to the start
    of a lesson you already finished is rewatching, not un-finishing.
    """

    if isinstance(position_seconds, bool) or not isinstance(position_seconds, int):
        raise ValueError("Position must be a whole number of seconds")
    if position_seconds < 0 or position_seconds > MAX_POSITION_SECONDS:
        raise ValueError("Position is out of range")

    now = utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO course_lesson_progress"
        " (customer_id, course_id, lesson_id, position_seconds, completed_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        " ON CONFLICT (customer_id, lesson_id) DO UPDATE SET"
        "   position_seconds = excluded.position_seconds,"
        "   completed_at = COALESCE(course_lesson_progress.completed_at, excluded.completed_at),"
        "   updated_at = excluded.updated_at"
    ).bind(customer_id, course_id, lesson_id, position_seconds, now if completed else None, now).run()


async def my_courses(env, customer_id: str) -> list[dict]:
    """The courses this member may watch right now, newest activity first.

    Progress is counted in one query rather than one per card, and so are the
    lesson totals and the covers: a member with a dozen courses should not cost
    a dozen round trips to render a list.

    `completedCount` on its own was never enough to draw. "已完成 3 個單元" says
    nothing about whether that is nearly done or barely started, which is the
    one thing somebody scanning this page wants to know.
    """

    course_ids = sorted(await entitlements.active_course_ids(env, customer_id))
    if not course_ids:
        return []

    placeholders = ", ".join(f"?{index + 1}" for index in range(len(course_ids)))
    courses = await d1_rows(
        env.DB.prepare(f"SELECT * FROM courses WHERE id IN ({placeholders})").bind(*course_ids)
    )
    progress = await d1_rows(
        env.DB.prepare(
            "SELECT course_id, COUNT(*) AS completed, MAX(updated_at) AS last_seen"
            " FROM course_lesson_progress WHERE customer_id = ?1 AND completed_at IS NOT NULL"
            " GROUP BY course_id"
        ).bind(customer_id)
    )
    totals = await d1_rows(
        env.DB.prepare(
            "SELECT s.course_id AS course_id, COUNT(l.id) AS total"
            " FROM course_sections s JOIN course_lessons l ON l.section_id = s.id"
            f" WHERE s.course_id IN ({placeholders})"
            " GROUP BY s.course_id"
        ).bind(*course_ids)
    )
    covers = await media.resolve(env, [course.get("cover_media_id") for course in courses])

    by_course = {row["course_id"]: row for row in progress}
    lesson_count = {row["course_id"]: int(row["total"]) for row in totals}

    cards = []
    for course in courses:
        seen = by_course.get(course["id"])
        # A cover whose picture has since been deleted comes back as nothing,
        # and the card draws its own placeholder. The alternative is the
        # browser's broken-image icon, which reads as the page being at fault.
        cover = covers.get(course.get("cover_media_id"))
        cards.append(
            {
                "id": course["id"],
                "slug": course["slug"],
                "title": course["title"],
                "summary": course.get("summary") or "",
                "coverPath": cover["path"] if cover else None,
                "completedCount": int(seen["completed"]) if seen else 0,
                "lessonCount": lesson_count.get(course["id"], 0),
                "lastViewedAt": int(seen["last_seen"]) if seen else None,
            }
        )
    cards.sort(key=lambda card: card["lastViewedAt"] or 0, reverse=True)
    return cards


async def course_for_member(env, *, customer_id: str, slug: str) -> dict | None:
    """A course as somebody who owns it reads it, or None.

    None rather than a redacted version: the lesson content *is* the product,
    and a shape that sometimes carries it and sometimes does not is one
    forgotten branch away from giving it away. What a visitor may see is a
    different function, on the product page, built for that purpose.

    Progress arrives with it. An outline without it is a list of names with no
    sense of where you were, which is the one thing this page exists to answer.
    """

    rows = await d1_rows(env.DB.prepare("SELECT * FROM courses WHERE slug = ?1").bind(slug))
    if not rows:
        return None
    course = rows[0]

    if course["id"] not in await entitlements.active_course_ids(env, customer_id):
        return None

    sections = await d1_rows(
        env.DB.prepare("SELECT * FROM course_sections WHERE course_id = ?1 ORDER BY position").bind(course["id"])
    )
    if not sections:
        return {"title": course["title"], "slug": course["slug"], "sections": []}

    placeholders = ", ".join(f"?{index + 1}" for index in range(len(sections)))
    lessons = await d1_rows(
        env.DB.prepare(
            f"SELECT * FROM course_lessons WHERE section_id IN ({placeholders}) ORDER BY position"
        ).bind(*[section["id"] for section in sections])
    )
    progress = await d1_rows(
        env.DB.prepare(
            "SELECT lesson_id, position_seconds, completed_at FROM course_lesson_progress"
            " WHERE customer_id = ?1 AND course_id = ?2"
        ).bind(customer_id, course["id"])
    )
    seen = {row["lesson_id"]: row for row in progress}

    # How long each lesson runs, and whether the transcode left a frame worth
    # showing. One query for the lot: a course is a list, and a round trip per
    # row to draw it is how a list gets slow.
    asset_ids = sorted({row["video_asset_id"] for row in lessons if row["video_asset_id"]})
    assets: dict[str, dict] = {}
    if asset_ids:
        asset_placeholders = ", ".join(f"?{index + 1}" for index in range(len(asset_ids)))
        assets = {
            row["id"]: row
            for row in await d1_rows(
                env.DB.prepare(
                    "SELECT id, duration_seconds, poster_key FROM video_assets"
                    f" WHERE id IN ({asset_placeholders})"
                ).bind(*asset_ids)
            )
        }
    chosen = await media.resolve(env, [row.get("cover_media_id") for row in lessons])

    by_section: dict[str, list[dict]] = {}
    for row in lessons:
        asset = assets.get(row["video_asset_id"]) if row["video_asset_id"] else None
        watched = seen.get(row["id"])
        by_section.setdefault(row["section_id"], []).append(
            {
                "id": row["id"],
                "title": row["title"],
                "contentHtml": row["content_html"],
                "hasVideo": bool(row["video_asset_id"]),
                "isPreview": bool(row["is_preview"]),
                "completed": watched is not None and watched["completed_at"] is not None,
                # Where they got to. The card needs this to say "看到 3:12"
                # rather than only "started", which is the difference between
                # somewhere to go back to and a fact about the past.
                "positionSeconds": int(watched["position_seconds"]) if watched else 0,
                "durationSeconds": (
                    int(asset["duration_seconds"])
                    if asset and asset["duration_seconds"] is not None
                    else None
                ),
                # One field, whichever kind it is. The page draws what it is
                # given; which of the two it came from is this function's
                # problem and nobody else's.
                "coverPath": _lesson_cover(row, asset, chosen),
            }
        )

    return {
        "title": course["title"],
        "slug": course["slug"],
        "summary": course.get("summary") or "",
        "sections": [
            {"title": section["title"], "lessons": by_section.get(section["id"], [])}
            for section in sections
        ],
    }


def _lesson_cover(lesson: dict, asset: dict | None, chosen: dict) -> str | None:
    """The picture for a lesson: the chosen one, else the frame the transcode
    grabbed, else nothing.

    In that order because the override is the deliberate act. Clearing it is
    how somebody goes back to the default, which only works if the default is
    never stored — the moment it were copied into the column, "revert" would
    mean finding the frame again.
    """

    picked = chosen.get(lesson.get("cover_media_id"))
    # `path` and not merely the row: a chosen picture whose file has since been
    # deleted resolves to a row with nothing to draw, and falling back to the
    # frame is better than a card with a hole in it.
    if picked and picked["path"]:
        return picked["path"]
    if asset and asset["poster_key"]:
        # Through the Worker rather than as a signed URL: a URL for a private
        # object is a capability that outlives the page it was put on, and a
        # thumbnail is not worth minting one for.
        return f"/api/learning/lessons/{lesson['id']}/poster"
    return None
