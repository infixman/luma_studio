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
