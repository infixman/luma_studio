"""Serving one HLS object to somebody whose token says they may have it.

Its own module because two Workers answer this route now. Members reach it on
the storefront, after buying a course; an admin reaches it on the back office,
to watch what a transcode actually produced before anybody is sold it. Both are
the same question — does this token cover this object — and a second copy of the
answer would be a second thing to get right about a private bucket.

Neither entrance widens the other. The token still names one asset and one
encode version, it is still short-lived, and it is still the only way past this
function.
"""

from domain import playback, video
from shared.common import env_var, utc_timestamp
from shared.responses import Ctx


COOKIE_NAME = "luma_playback"


def signing_secrets(env) -> tuple[str, str | None]:
    """The signing key, and the one being rotated out if there is one.

    Public because both Workers mint tokens as well as check them, and a
    caller reading `PLAYBACK_SECRET` itself would quietly skip the rotation.
    """

    return env_var(env, "PLAYBACK_SECRET"), env_var(env, "PLAYBACK_SECRET_PREVIOUS") or None


def cookie_token(request) -> str:
    raw = request.headers.get("Cookie") or ""
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return ""


def session_cookie(token: str, *, path_prefix: str) -> str:
    """The cookie a playback session is carried in.

    Scoped to the objects it opens: a cookie for the whole host would be sent
    with every other request, and this one is a capability.
    """

    return (
        f"{COOKIE_NAME}={token}; Path={path_prefix}; Max-Age={playback.DEFAULT_TTL};"
        " Secure; HttpOnly; SameSite=Lax"
    )


def session_response(ctx: Ctx, claim: dict, *, asset_id: str, encode_version: int, now: int):
    """Mint a token for one encode, and say where to point a player at it.

    Both Workers end their minting route here rather than each writing the URL
    shape, the expiry and the cookie out again — three things that have to
    agree with what `media_response` will accept, and no way to notice when
    one copy drifts.
    """

    secret, _ = signing_secrets(ctx.env)
    if not secret:
        # Without a key nothing can be signed, and issuing an unsigned token
        # would be worse than refusing.
        return ctx.error("播放服務尚未設定", 503)

    token = playback.issue(claim, secret=secret, now=now)
    prefix = f"/course-media/{asset_id}/{encode_version}/"
    return ctx.json(
        {"playbackUrl": f"{prefix}master.m3u8", "expiresAt": now + playback.DEFAULT_TTL},
        extra_headers={"Set-Cookie": session_cookie(token, path_prefix=prefix)},
    )


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

    if not video.allowed_object(object_path):
        return ctx.error("Not found", 404)
    try:
        encode_version = int(raw_version)
        # Built through the key helper, which validates both parts. The id here
        # arrives in the URL, and a key assembled from it by hand was correct
        # only because R2 treats a key as a literal string rather than a path.
        key = f"{video.encode_prefix(asset_id, encode_version)}{object_path}"
    except ValueError:
        return ctx.error("Not found", 404)

    secret, previous = signing_secrets(ctx.env)
    claim = playback.verify(cookie_token(ctx.request), secret=secret, now=utc_timestamp(), previous_secret=previous)
    if not playback.covers(claim, asset_id=asset_id, encode_version=encode_version):
        # One answer for expired, forged, missing and for-something-else. The
        # difference is useful in a log and useful to an attacker.
        return ctx.error("Forbidden", 403)

    stored = await ctx.env.COURSE_VIDEO.get(key)
    if stored is None:
        return ctx.error("Not found", 404)

    # Streamed, never read here. Reading a segment into Python costs two copies
    # of a file that is megabytes — the ArrayBuffer R2 hands over and the bytes
    # built from it — and the Worker was killed part-way through:
    #
    #     GET .../1080p/segment-000001.m4s - Exceeded CPU Limit
    #
    # A request killed mid-flight leaves its task half-executed, and every
    # request that lands on that isolate afterwards cannot enter the event loop
    # and is cancelled for never answering. One segment took the whole
    # deployment down for as long as the isolate lived.
    return ctx.stream(stored.body, _media_headers(object_path))


def _media_headers(object_path: str) -> dict:
    """Content type and caching, decided by what the pipeline writes.

    Segments are immutable — a new encode is a new version and therefore a new
    URL — so they can be kept for ever. A playlist is kept briefly: it is the
    thing a player re-reads, and the short window is what lets a switched
    encode version be picked up without waiting out a long TTL.

    Caching is left to the browser and the edge rather than done here. The
    Worker used to put segments in the shared cache itself, which meant holding
    a whole one in Python — the cost that killed the isolate. `private` because
    what is behind these URLs is not public; the token in front of them is what
    decides who may ask.
    """

    if object_path.endswith(".m3u8"):
        return {"Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "private, max-age=60"}
    if object_path.endswith(".webp"):
        return {"Content-Type": "image/webp", "Cache-Control": "private, max-age=31536000, immutable"}
    if object_path.endswith(".mp4") or object_path.endswith(".m4s"):
        return {"Content-Type": "video/mp4", "Cache-Control": "private, max-age=31536000, immutable"}
    return {"Content-Type": "application/octet-stream", "Cache-Control": "private, no-store"}
