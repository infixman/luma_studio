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

from js import Uint8Array

from domain import playback, video
from shared.common import env_var, utc_timestamp
from shared.responses import Ctx


COOKIE_NAME = "luma_playback"

# What is worth keeping at the edge. These are immutable: a re-encode is a new
# version and therefore a new key, so a hit is always the right bytes.
#
# Playlists are left out on purpose. They are what a player re-reads, and a
# switched encode version has to be picked up without waiting out a TTL.
CACHEABLE_SUFFIXES = (".m4s", ".mp4", ".webp")


def is_cacheable(object_path: str) -> bool:
    return object_path.endswith(CACHEABLE_SUFFIXES)


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

    # Only after the token has been checked. A cached object that could be
    # served without one would mean the first member to watch a lesson opened
    # it for everybody — the cache key deliberately carries no identity, which
    # is what makes it shareable and also what makes the order matter.
    cached = await _cached(ctx, key) if is_cacheable(object_path) else None
    if cached is not None:
        return ctx.binary(cached, _media_headers(object_path))

    stored = await ctx.env.COURSE_VIDEO.get(key)
    if stored is None:
        return ctx.error("Not found", 404)

    body = bytes(Uint8Array.new(await stored.arrayBuffer()).to_py())
    if is_cacheable(object_path):
        await _remember(ctx, key, body, object_path)
    return ctx.binary(body, _media_headers(object_path))


def _cache_url(key: str) -> str:
    """A stable, identity-free URL to key the cache on.

    Not the request URL: that would work, but tying the entry to the incoming
    path means a change to the route invalidates a cache full of bytes that
    have not changed.
    """

    return f"https://course-media.internal/{key}"


async def _cached(ctx: Ctx, key: str) -> bytes | None:
    """Whatever the edge already has, or None.

    Every failure is None. A cache that is unavailable, or a runtime without
    one, must not stop somebody watching a lesson.
    """

    try:
        from js import Request, caches

        hit = await caches.default.match(Request.new(_cache_url(key)))
        if hit is None:
            return None
        return bytes(Uint8Array.new(await hit.arrayBuffer()).to_py())
    except Exception:
        return None


async def _remember(ctx: Ctx, key: str, body: bytes, object_path: str) -> None:
    """Put an object in the shared cache, or carry on without."""

    try:
        from js import Request, Response, caches
        from pyodide.ffi import to_js

        headers = _media_headers(object_path)
        await caches.default.put(
            Request.new(_cache_url(key)),
            Response.new(to_js(body), headers=to_js(headers, dict_converter=__import__("js").Object.fromEntries)),
        )
    except Exception:
        # Failing to cache is not failing to serve.
        pass


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
