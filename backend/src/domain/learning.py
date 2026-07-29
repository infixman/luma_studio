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

from domain import entitlements
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

    if not lesson["video_asset_id"]:
        return {"allowed": False, "reason": "no_video"}

    course = await _course_of_lesson(env, lesson["section_id"])
    if course is None:
        return {"allowed": False, "reason": "not_found"}

    is_preview = bool(lesson["is_preview"])
    entitlement = None
    if not is_preview:
        if customer_id is None:
            return {"allowed": False, "reason": "not_entitled"}
        entitlement = await entitlements.get_entitlement(env, customer_id, course["id"])
        if entitlement is None:
            return {"allowed": False, "reason": "not_entitled"}
        if not entitlements.is_active(entitlement, now=utc_timestamp()):
            # Told apart on purpose: a window that ran out can be bought
            # again, and a revoked one is a conversation with the shop.
            reason = "revoked" if entitlement["revokedAt"] is not None else "expired"
            return {"allowed": False, "reason": reason}

    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM video_assets WHERE id = ?1").bind(lesson["video_asset_id"])
    )
    asset = rows[0] if rows else None
    if asset is None or asset["status"] != "ready" or asset["active_encode_version"] is None:
        # A clear "not yet" beats a player failing on a 404 it cannot explain.
        return {"allowed": False, "reason": "not_ready"}

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

    Progress is counted in one query rather than one per card: a member with a
    dozen courses should not cost a dozen round trips to render a list.
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
    by_course = {row["course_id"]: row for row in progress}

    cards = []
    for course in courses:
        seen = by_course.get(course["id"])
        cards.append(
            {
                "id": course["id"],
                "slug": course["slug"],
                "title": course["title"],
                "completedCount": int(seen["completed"]) if seen else 0,
                "lastViewedAt": int(seen["last_seen"]) if seen else None,
            }
        )
    cards.sort(key=lambda card: card["lastViewedAt"] or 0, reverse=True)
    return cards
