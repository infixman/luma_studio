"""Endpoints the desktop uploader talks to.

Split from the rest of the back office because the routes here do not all sit on
the same side of the authentication gate, and that difference is the design
rather than an accident.

`pairing-code` is behind a session. That is the whole scheme: a code is only
visible to somebody already signed in, which is what makes showing one an act of
authorisation. Nothing else about it is secret — the server generates and
verifies it — so if it could be read without a session it would be worth
nothing.

Two handlers here sit on different sides of that gate, and it is worth saying so
where somebody adding a third will read it. `serve_mirror` is authenticated: the
FFmpeg archive is not secret, but the bandwidth is ours. `serve_release` is
public, because an updater checks for a new build before anybody has signed into
anything — `admin_main` routes to it before the gate, deliberately.
"""

from domain import desktop_auth, desktop_release, desktop_tools
from shared import rate_limit
from shared.common import NotConfigured, utc_timestamp
from shared.responses import Ctx

MIRROR_BINDING = "DESKTOP_TOOLS"


def _request_origin(ctx: Ctx) -> str:
    """The scheme and host this request arrived on.

    Read from the request rather than configured. A hard-coded feed URL is wrong
    on whichever deployment is not the production one, and wrong silently: a
    staging build would check the live feed and offer itself the wrong installer.
    """

    url = str(ctx.request.url)
    scheme, _, rest = url.partition("://")
    host = rest.split("/", 1)[0]
    return f"{scheme}://{host}" if host else ""


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


async def _stream_from_tools(ctx: Ctx, key: str, *, content_type: str, cache: str):
    """Hand over one object from the tools bucket, or say why not.

    Streamed rather than read. `serve_r2_object` buffers, which costs two copies
    of the whole object — R2's ArrayBuffer and the Python `bytes` built from it —
    and a Worker has 128 MB. The FFmpeg archive alone is 74 MB.
    """

    bucket = getattr(ctx.env, MIRROR_BINDING, None)
    if bucket is None:
        # Said outright rather than answered as a missing file: an unconfigured
        # deployment and an empty bucket look identical from outside, and only
        # one of them is fixed by uploading something.
        return ctx.error(f"工具檔案尚未設定（缺少 {MIRROR_BINDING} binding）", 503)

    stored = await bucket.get(key)
    if stored is None:
        return ctx.error("Not found", 404)

    return ctx.stream(
        stored.body,
        {
            "content-type": content_type,
            "cache-control": cache,
            "x-content-type-options": "nosniff",
        },
    )


async def serve_mirror(ctx: Ctx, name: str):
    """Hand over the pinned FFmpeg, or its corresponding source.

    Behind the same gate as everything else, and reachable by a video-scoped
    token — see `desktop_auth._VIDEO_ROUTES`. The bytes are a published GPL build
    rather than a secret; what the token protects is our bandwidth.

    Streamed rather than read. `serve_r2_object` buffers, which costs two copies
    of the whole object — R2's ArrayBuffer and the Python `bytes` built from it —
    and a Worker has 128 MB. The archive is 74 MB even repacked down to two
    executables and a licence, so buffering it is about 148 MB and the request
    dies instead of answering.
    """

    key = desktop_tools.mirror_key(name)
    if key is None:
        # 404 rather than 400. A name this route does not serve and a name that is
        # not there are the same thing from outside, and the difference is only
        # useful to somebody probing.
        return ctx.error("Not found", 404)

    # Immutable because the name carries the version and the tool checks a digest
    # before unpacking: a stale copy cannot be a wrong copy.
    return await _stream_from_tools(
        ctx,
        key,
        content_type="application/octet-stream",
        cache=f"public, max-age={desktop_tools.CACHE_SECONDS}, immutable",
    )


async def serve_release(ctx: Ctx, name: str):
    """The installer and the metadata electron-updater reads.

    Public, and the only route on this Worker that is not about video. An updater
    checks for a new build before anybody has signed into anything, and the two
    admins who install it are not going to paste a token into a Windows updater.

    What is published here is a build we made, so nothing about it is secret —
    and the bytes are the same ones an installed tool already has. The narrowing
    is the name.
    """

    if not await rate_limit.allows(ctx.env, rate_limit.RELEASE, ctx.request, "release"):
        # Unauthenticated and tens of megabytes an answer. The limiter is
        # advisory — it fails open when its binding is absent — but a public
        # route that hands out installers should at least be behind the same
        # thing every other public byte-serving route is.
        return ctx.too_many_requests()

    key = desktop_release.release_key(name)
    if key is None:
        return ctx.error("Not found", 404)

    # `latest.yml` is deliberately not immutable — it is the file an updater
    # re-reads to find out a new version exists, and a cached one is an update
    # nobody is offered. The installer carries its version in its own name, so it
    # can be cached hard.
    metadata = name.endswith(".yml")
    return await _stream_from_tools(
        ctx,
        key,
        content_type="text/yaml" if metadata else "application/octet-stream",
        cache="public, max-age=60"
        if metadata
        else f"public, max-age={desktop_tools.CACHE_SECONDS}, immutable",
    )


async def handle(ctx: Ctx):
    if ctx.path.startswith("/tools/ffmpeg/") and ctx.method == "GET":
        return await serve_mirror(ctx, ctx.path[len("/tools/ffmpeg/") :])

    if ctx.path == "/api/desktop/version-policy" and ctx.method == "GET":
        # Readable by the tool as well as the back office: it is the answer to
        # "may I work", and a tool that cannot ask has to assume yes.
        policy = await desktop_release.read_policy(ctx.env)
        asked = (ctx.query.get("version") or [""])[0].strip()
        return ctx.json(
            {
                **policy,
                # Built from whichever deployment answered rather than
                # configured: a hard-coded host is wrong on the deployment that
                # is not production, and wrong silently.
                "feedUrl": desktop_release.feed_url(_request_origin(ctx)),
                "verdict": desktop_release.verdict(policy, asked) if asked else None,
            }
        )

    if ctx.path == "/api/desktop/version-policy" and ctx.method == "PUT":
        try:
            body = await ctx.json_body()
            return ctx.json(
                await desktop_release.save_policy(
                    ctx.env,
                    latest=str(body.get("latest") or ""),
                    min_supported=str(body.get("minSupported") or ""),
                    # Only a real boolean. `"false"` is truthy in Python, and
                    # this is the field that stops every installed tool.
                    force_update=body.get("forceUpdate") is True,
                    blocked=body.get("blocked") is True,
                    notes=str(body.get("notes") or ""),
                    now=utc_timestamp(),
                )
            )
        except ValueError as error:
            return ctx.error(str(error) or "Invalid policy", 400)
        except (AttributeError, TypeError):
            return ctx.error("Invalid policy", 400)

    if ctx.path == "/api/desktop/releases" and ctx.method == "GET":
        # The record, never the bucket. Opening this page must not spend a
        # listing — asking for one is the route below, and it is a POST because
        # it costs money and rewrites what is recorded.
        return ctx.json(await desktop_release.recorded_releases(ctx.env))

    if ctx.path == "/api/desktop/releases/refresh" and ctx.method == "POST":
        try:
            return ctx.json(await desktop_release.refresh_releases(ctx.env, now=utc_timestamp()))
        except NotConfigured as error:
            return ctx.error(str(error) or "工具檔案尚未設定", 503)

    if ctx.path.startswith("/api/desktop/releases/") and ctx.method == "DELETE":
        try:
            return ctx.json(
                await desktop_release.delete_release(
                    ctx.env, version=ctx.path[len("/api/desktop/releases/") :]
                )
            )
        except ValueError as error:
            # 409 rather than 400: what refuses this is the state of the policy
            # rather than the shape of the request, and the policy is something
            # the caller can go and change. A segment that is not a version at
            # all arrives here too, and says which of the two it was.
            return ctx.error(str(error) or "無法刪除這個版本", 409)
        except LookupError as error:
            return ctx.error(str(error) or "Not found", 404)
        except NotConfigured as error:
            return ctx.error(str(error) or "工具檔案尚未設定", 503)

    if ctx.path == "/api/desktop/pairing-code" and ctx.method == "GET":
        try:
            # For whoever is signed in, never for an address in the request. A
            # code for somebody else is a code that authorises a machine as
            # them.
            return ctx.json(desktop_auth.pairing_code(ctx.env, ctx.admin_email, now=utc_timestamp()))
        except NotConfigured as error:
            return ctx.error(str(error) or "桌面工具配對尚未設定", 503)

    return ctx.error("Not found", 404)
