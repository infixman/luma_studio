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

from domain import entitlements, learning, playback, video
from shared.common import env_var, utc_timestamp
from shared.responses import Ctx


# The cookie is scoped to the media path and marked HttpOnly, so a shared
# manifest URL carries none of it and page scripts cannot read it.
COOKIE_NAME = "luma_playback"


def _secrets(env) -> tuple[str, str | None]:
    """The signing key, and the one being rotated out if there is one."""

    return env_var(env, "PLAYBACK_SECRET"), env_var(env, "PLAYBACK_SECRET_PREVIOUS") or None


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


async def playback_session_response(ctx: Ctx, customer: dict | None, lesson_id: str):
    """Check once, then hand out a token that says exactly what it opens."""

    secret, _ = _secrets(ctx.env)
    if not secret:
        # Without a key nothing can be signed, and issuing an unsigned token
        # would be worse than refusing.
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

    token = playback.issue(
        {
            "customerId": customer["id"] if customer else None,
            "courseId": decision["courseId"],
            "lessonId": decision["lessonId"],
            "assetId": decision["assetId"],
            "encodeVersion": decision["encodeVersion"],
            "scope": decision["scope"],
        },
        secret=secret,
        now=now,
    )
    path_prefix = f"/course-media/{decision['assetId']}/{decision['encodeVersion']}/"
    return ctx.json(
        {"playbackUrl": f"{path_prefix}master.m3u8", "expiresAt": now + playback.DEFAULT_TTL},
        extra_headers={
            "Set-Cookie": (
                f"{COOKIE_NAME}={token}; Path={path_prefix}; Max-Age={playback.DEFAULT_TTL};"
                " Secure; HttpOnly; SameSite=Lax"
            )
        },
    )


async def progress_response(ctx: Ctx, customer: dict, lesson_id: str):
    try:
        body = await ctx.json_body()
        decision = await learning.playable(ctx.env, customer_id=customer["id"], lesson_id=lesson_id)
        if not decision["allowed"] and decision["reason"] != "no_video":
            # A reading has no video and is still something to finish.
            return _refusal(ctx, decision["reason"])
        await learning.save_progress(
            ctx.env,
            customer_id=customer["id"],
            course_id=decision.get("courseId") or str(body.get("courseId") or ""),
            lesson_id=lesson_id,
            position_seconds=body.get("positionSeconds", 0),
            completed=bool(body.get("completed")),
        )
    except (ValueError, AttributeError) as error:
        return ctx.error(str(error) or "Invalid progress", 400)
    return ctx.json({"saved": True})


def _cookie_token(request) -> str:
    raw = request.headers.get("Cookie") or ""
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return ""


async def media_response(ctx: Ctx, path: str):
    """Serve one HLS object, if the caller's token says it may.

    No database call. That is the whole point of the token: this runs
    hundreds of times per lesson, and the check it replaces already happened
    when the session was created.
    """

    parts = path.split("/", 2)
    if len(parts) != 3:
        return ctx.error("Not found", 404)
    asset_id, raw_version, object_path = parts

    if not playback.allowed_object(object_path):
        return ctx.error("Not found", 404)
    try:
        encode_version = int(raw_version)
    except ValueError:
        return ctx.error("Not found", 404)

    secret, previous = _secrets(ctx.env)
    claim = playback.verify(_cookie_token(ctx.request), secret=secret, now=utc_timestamp(), previous_secret=previous)
    if not playback.covers(claim, asset_id=asset_id, encode_version=encode_version):
        # One answer for expired, forged, missing and for-something-else. The
        # difference is useful in a log and useful to an attacker.
        return ctx.error("Forbidden", 403)

    key = f"videos/{asset_id}/{encode_version}/{object_path}"
    stored = await ctx.env.COURSE_VIDEO.get(key)
    if stored is None:
        return ctx.error("Not found", 404)

    body = (await stored.arrayBuffer()).to_py()
    return ctx.binary(bytes(body), _media_headers(object_path))


def _media_headers(object_path: str) -> dict:
    """Content type and caching, decided by what the pipeline writes.

    Segments are immutable — a new encode is a new version and therefore a new
    URL — so they can be cached hard. A playlist is cached briefly: it is the
    thing a player re-reads, and the short window is what lets a switched
    encode version be picked up without waiting out a long TTL.
    """

    if object_path.endswith(".m3u8"):
        return {"Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "private, max-age=60"}
    if object_path.endswith(".webp"):
        return {"Content-Type": "image/webp", "Cache-Control": "private, max-age=3600"}
    if object_path.endswith(".mp4") or object_path.endswith(".m4s"):
        return {"Content-Type": "video/mp4", "Cache-Control": "private, max-age=31536000, immutable"}
    return {"Content-Type": "application/octet-stream", "Cache-Control": "private, no-store"}


__all__ = [
    "COOKIE_NAME",
    "media_response",
    "my_courses_response",
    "playback_session_response",
    "progress_response",
    "video",
]
