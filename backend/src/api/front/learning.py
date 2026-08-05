"""Member learning routes and the playback gateway.

Two different kinds of endpoint live here, and they are authorised
differently on purpose.

The learning routes ask the database: who is this, what do they own, may they
have this lesson. That is a handful of queries and happens once per lesson.

The gateway does not. A lesson is hundreds of segment requests, and checking
entitlements on each would cost more than it protects. It verifies a
short-lived signed token instead, which was issued by a learning route that
did all of the above. The token's life is the bound on how stale that decision
can be.
"""

from api import media_gateway
from domain import entitlements, learning, video
from shared.common import CACHE_PRIVATE_VERSIONED, utc_timestamp
from shared.responses import Ctx, serve_r2_object


def _refusal(ctx: Ctx, reason: str):
    """Turn a refusal into words and a status the page can act on."""

    messages = {
        "not_found": ("找不到這個單元", 404),
        "no_video": ("這個單元沒有影片", 404),
        "not_ready": ("影片還在處理中，請稍後再試", 409),
        "not_entitled": ("你還沒有這門課程的觀看權", 403),
        "expired": ("這門課程的觀看期限已經結束", 403),
        "revoked": ("這門課程的觀看權已被取消", 403),
    }
    message, status = messages.get(reason, ("無法播放", 403))
    return ctx.error(message, status, {"reason": reason})


async def my_courses_response(ctx: Ctx, customer: dict):
    return ctx.json({"courses": await learning.my_courses(ctx.env, customer["id"])})


async def course_response(ctx: Ctx, customer: dict, slug: str):
    course = await learning.course_for_member(ctx.env, customer_id=customer["id"], slug=slug)
    # 404 rather than 403: whether this member owns a course is not something
    # a stranger should be able to establish by watching which error comes back.
    return ctx.json(course) if course else ctx.error("找不到這門課程", 404)


async def playback_session_response(ctx: Ctx, customer: dict | None, lesson_id: str):
    """Check once, then hand out a token that says exactly what it opens."""

    # Asked before the entitlement work rather than left to the mint below:
    # starting somebody's viewing window and then refusing to issue the token
    # would spend a day of their access on a lesson they never saw.
    secret, _ = media_gateway.signing_secrets(ctx.env)
    if not secret:
        return ctx.error("播放服務尚未設定", 503)

    decision = await learning.playable(
        ctx.env, customer_id=customer["id"] if customer else None, lesson_id=lesson_id
    )
    if not decision["allowed"]:
        return _refusal(ctx, decision["reason"])

    now = utc_timestamp()

    # The window starts at the first watch, not at payment. A member waiting
    # on a material kit should not be spending their thirty days on the post.
    if decision["entitlementId"] and decision["accessDays"] is not None:
        await entitlements.start_viewing_window(
            ctx.env,
            entitlement_id=decision["entitlementId"],
            access_days=decision["accessDays"],
            now=now,
        )

    return media_gateway.session_response(
        ctx,
        {
            "customerId": customer["id"] if customer else None,
            "courseId": decision["courseId"],
            "lessonId": decision["lessonId"],
            "assetId": decision["assetId"],
            "encodeVersion": decision["encodeVersion"],
            "scope": decision["scope"],
        },
        asset_id=decision["assetId"],
        encode_version=decision["encodeVersion"],
        now=now,
    )


async def lesson_poster_response(ctx: Ctx, customer: dict | None, lesson_id: str):
    """The frame the transcode grabbed, for somebody allowed to watch it.

    Through the Worker rather than as a signed URL: a URL for a private object
    is a capability that outlives the page it was put on, and a thumbnail is
    not worth minting one for.

    The same `playable` decision the player uses, so a course somebody no
    longer owns stops showing them its pictures at the same moment it stops
    playing. Cheaper than it looks — a poster is one request per card, not the
    hundreds a lesson's segments make, which is why this can afford the check
    the gateway cannot.
    """

    decision = await learning.playable(
        ctx.env, customer_id=customer["id"] if customer else None, lesson_id=lesson_id
    )
    if not decision["allowed"]:
        return _refusal(ctx, decision["reason"])

    return await serve_r2_object(
        ctx,
        ctx.env.COURSE_VIDEO,
        video.poster_key(decision["assetId"], decision["encodeVersion"]),
        {".webp": "image/webp"},
        CACHE_PRIVATE_VERSIONED,
    )


async def progress_response(ctx: Ctx, customer: dict, lesson_id: str):
    decision = await learning.playable(ctx.env, customer_id=customer["id"], lesson_id=lesson_id)
    # A reading has no video and is still something to finish, so `no_video`
    # is the one refusal that still allows progress. Every other one — not
    # bought, expired, revoked — is a refusal to record anything.
    if not decision["allowed"] and decision["reason"] != "no_video":
        return _refusal(ctx, decision["reason"])

    try:
        body = await ctx.json_body()
        await learning.save_progress(
            ctx.env,
            customer_id=customer["id"],
            # From the lesson, never from the request. A client-supplied course
            # id is a client deciding which course its progress counts towards.
            course_id=decision["courseId"],
            lesson_id=lesson_id,
            position_seconds=body.get("positionSeconds", 0),
            completed=bool(body.get("completed")),
        )
    except ValueError as error:
        # Our own validation messages are meant to be read; anything else is
        # an internal detail and is not repeated back.
        return ctx.error(str(error) or "Invalid progress", 400)
    except (AttributeError, TypeError):
        return ctx.error("Invalid progress", 400)
    return ctx.json({"saved": True})


__all__ = [
    "course_response",
    "lesson_poster_response",
    "my_courses_response",
    "playback_session_response",
    "progress_response",
]
