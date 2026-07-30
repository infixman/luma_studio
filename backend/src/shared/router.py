"""The request pipeline both Workers share.

The public API and the admin API are separate deployments so that a script
running on the storefront cannot reach the admin session cookie: neither
cookie sets a `Domain`, so each one only ever travels back to the host that
issued it. What the two deployments still have in common is the shape of a
request — answer preflights, refuse forged cross-site writes, make sure the
schema is current, then route — and one of those steps is a security check.
Keeping a copy per Worker would let the copies drift apart, and the copy that
drifts is the one nobody was looking at.
"""

import traceback
from urllib.parse import parse_qs

from shared.common import MigrationError
from shared.migrations import apply_migrations
from shared.responses import Ctx


def path_and_query(request) -> tuple[str, dict]:
    """Split a request URL without asking the runtime for a URL parser."""

    request_url = str(request.url)
    scheme_end = request_url.find("://")
    path_start = request_url.find("/", scheme_end + 3)
    path_and_rest = request_url[path_start:] if path_start >= 0 else "/"
    path, _, raw_query = path_and_rest.partition("?")
    return path.rstrip("/") or "/", parse_qs(raw_query)


async def serve(env, request, dispatch, *, owns_schema: bool, csrf_exempt: tuple = ()):
    """Run one request through the shared gates and hand it to `dispatch`.

    `owns_schema` belongs to exactly one deployment. Migrations are applied by
    the admin Worker and nowhere else: checkout is a hot path that should not
    pay for a schema check on every cold isolate, and a Worker the public can
    reach has no business being able to ALTER TABLE.

    `csrf_exempt` names the few paths where there is no ambient credential for a
    forged request to abuse — the desktop tool's pairing exchange has neither a
    cookie nor a token yet, which is the whole reason it exists. Listed here, by
    the deployment that owns the route, rather than inferred: a check that
    exempts paths it guessed at is a check nobody can audit.
    """

    path, query = path_and_query(request)
    ctx = Ctx(env, request, path, query)

    if ctx.method == "OPTIONS":
        return ctx.preflight()

    if path not in csrf_exempt and not ctx.has_csrf_protection():
        if not ctx.allowed_origins:
            return ctx.error("Backend is missing ALLOWED_ORIGINS", 500)
        return ctx.error("Cross-site request rejected", 403)

    if owns_schema:
        try:
            await apply_migrations(env)
        except MigrationError as error:
            return ctx.json({"error": "Database migration failed", "migration": error.name}, 503)

    try:
        return await dispatch(ctx)
    except Exception as error:
        # An exception that escapes a handler becomes Cloudflare's 1101 page,
        # which tells the caller nothing and the owner only that something
        # threw. Answering with our own 500 keeps the response readable and
        # keeps the traceback in the Worker's logs where it can be read; the
        # path is included because a 1101 does not even say which route.
        traceback.print_exc()
        return ctx.json({"error": "Unexpected Worker failure", "path": path}, 500)
