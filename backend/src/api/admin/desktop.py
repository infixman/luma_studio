"""Endpoints the desktop uploader talks to.

Split from the rest of the back office because the routes here do not all sit on
the same side of the authentication gate, and that difference is the design
rather than an accident.

`pairing-code` is behind a session. That is the whole scheme: a code is only
visible to somebody already signed in, which is what makes showing one an act of
authorisation. Nothing else about it is secret — the server generates and
verifies it — so if it could be read without a session it would be worth
nothing.
"""

from domain import desktop_auth, desktop_tools
from shared.common import NotConfigured, utc_timestamp
from shared.responses import Ctx, serve_r2_object

MIRROR_BINDING = "DESKTOP_TOOLS"


async def handle_public(ctx: Ctx):
    """The one desktop route that cannot be behind a session.

    A tool starting for the first time has nothing to present, which is the
    whole point of a pairing code. Everything that makes it survivable is inside
    `desktop_auth.exchange`: single use, no replaying an older window, and a
    lock after a handful of wrong codes.
    """

    if ctx.path == "/api/desktop/tokens" and ctx.method == "POST":
        try:
            body = await ctx.json_body()
        except (AttributeError, TypeError, ValueError):
            body = {}
        granted = await desktop_auth.exchange(
            ctx.env, email=body.get("email"), code=body.get("code"), now=utc_timestamp()
        )
        if granted is None:
            # One answer for every reason. Telling a caller that the account is
            # locked, or that the code was right but already spent, is telling
            # them how far along they are.
            return ctx.error("配對失敗，請重新取得驗證碼", 401)
        return ctx.json(granted)

    return ctx.error("Not found", 404)


async def serve_mirror(ctx: Ctx, name: str):
    """Hand over the pinned FFmpeg, or its corresponding source.

    Behind the same gate as everything else, and reachable by a video-scoped
    token — see `desktop_auth._VIDEO_ROUTES`. The bytes are a published GPL build
    rather than a secret; what the token protects is our bandwidth.

    The whole object is read into memory — that is what `serve_r2_object` does.
    Fine for the archive this is for, a minimal FFmpeg being around twenty
    megabytes, and the reason the mirror should hold `ffmpeg.exe` and
    `ffprobe.exe` rather than a full 170 MB build with a media player in it.
    """

    key = desktop_tools.mirror_key(name)
    if key is None:
        # 404 rather than 400. A name this route does not serve and a name that is
        # not there are the same thing from outside, and the difference is only
        # useful to somebody probing.
        return ctx.error("Not found", 404)

    bucket = getattr(ctx.env, MIRROR_BINDING, None)
    if bucket is None:
        # Said outright rather than answered as a missing file: an unconfigured
        # deployment and an empty mirror look identical from the tool, and only
        # one of them is fixed by uploading something.
        return ctx.error(f"工具鏡像尚未設定（缺少 {MIRROR_BINDING} binding）", 503)

    # No suffix map, so it falls through to `application/octet-stream` — which is
    # what a zip somebody is about to hash and unpack should be. Immutable because
    # the name carries the version and the tool checks a digest before unpacking:
    # a stale copy cannot be a wrong copy.
    return await serve_r2_object(
        ctx, bucket, key, {}, cache=f"public, max-age={desktop_tools.CACHE_SECONDS}, immutable"
    )


async def handle(ctx: Ctx):
    if ctx.path.startswith("/tools/ffmpeg/") and ctx.method == "GET":
        return await serve_mirror(ctx, ctx.path[len("/tools/ffmpeg/") :])

    if ctx.path == "/api/desktop/pairing-code" and ctx.method == "GET":
        try:
            # For whoever is signed in, never for an address in the request. A
            # code for somebody else is a code that authorises a machine as
            # them.
            return ctx.json(desktop_auth.pairing_code(ctx.env, ctx.admin_email, now=utc_timestamp()))
        except NotConfigured as error:
            return ctx.error(str(error) or "桌面工具配對尚未設定", 503)

    return ctx.error("Not found", 404)
