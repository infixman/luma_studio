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

from domain import desktop_auth
from shared.common import NotConfigured, utc_timestamp
from shared.responses import Ctx


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


async def handle(ctx: Ctx):
    if ctx.path == "/api/desktop/pairing-code" and ctx.method == "GET":
        try:
            # For whoever is signed in, never for an address in the request. A
            # code for somebody else is a code that authorises a machine as
            # them.
            return ctx.json(desktop_auth.pairing_code(ctx.env, ctx.admin_email, now=utc_timestamp()))
        except NotConfigured as error:
            return ctx.error(str(error) or "桌面工具配對尚未設定", 503)

    return ctx.error("Not found", 404)
