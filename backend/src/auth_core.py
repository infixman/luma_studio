"""The parts of Google sign-in that the two logins have in common.

There are two: the owner signing in to the back office, and a customer
signing in to buy something. They use different OAuth clients, different
tables and different cookie names, and neither deployment can read the
other's session. What they share is the mechanics — PKCE, the state row, the
token exchange — and that is what lives here.

The table names below arrive from module constants in `auth_admin` and
`auth_customer`, never from a request. They are interpolated into SQL because
a table name cannot be bound as a parameter; nothing reachable from a caller
can influence them.
"""

import base64
import hashlib
from urllib.parse import urlencode

from common import OAUTH_STATE_TTL_SECONDS, OAuthError, d1_rows, urlsafe_token, utc_timestamp
from ibon import fetch_json
from responses import Ctx, frontend_origin


def get_cookie(request, name: str) -> str | None:
    cookie_header = request.headers.get("Cookie") or ""
    for item in cookie_header.split(";"):
        key, separator, value = item.strip().partition("=")
        if separator and key == name:
            return value
    return None


def session_cookie(name: str, session_id: str, max_age: int) -> str:
    """A host-only session cookie.

    No Domain attribute, deliberately. That is what keeps the back office's
    cookie from ever being sent to the public API, and the customer's from
    reaching the admin one — the whole reason the two Workers are separate.

    The frontend and its API share a registrable domain, so requests between
    them are same-site and Lax is enough. Lax also means a cross-site POST
    cannot carry the cookie at all. `Ctx.has_csrf_protection` still enforces
    the Origin allowlist and the preflight-forcing header, because the two
    origins differ even though the site does not.
    """

    return f"{name}={session_id}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"


def safe_return_url(ctx: Ctx, candidate: str, default_path: str) -> str:
    """Only ever send the browser back to a configured frontend origin."""

    default = f"{frontend_origin(ctx.env)}{default_path}"
    if not candidate:
        return default
    for origin in ctx.allowed_origins:
        if candidate == origin or candidate.startswith(f"{origin}/"):
            return candidate
    return default


async def begin_login(ctx: Ctx, *, states_table: str, client_id: str, redirect_uri: str, default_path: str):
    state, verifier = urlsafe_token(), urlsafe_token(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    now = utc_timestamp()
    next_url = safe_return_url(ctx, (ctx.query.get("next") or [""])[0], default_path)
    env = ctx.env
    await env.DB.prepare(f"DELETE FROM {states_table} WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare(
        f"INSERT INTO {states_table} (state, code_verifier, next_url, expires_at) VALUES (?1, ?2, ?3, ?4)"
    ).bind(state, verifier, next_url, now + OAUTH_STATE_TTL_SECONDS).run()
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
    )
    return ctx.redirect(f"https://accounts.google.com/o/oauth2/v2/auth?{query}")


async def complete_login(
    ctx: Ctx, *, states_table: str, client_id: str, client_secret: str, redirect_uri: str
) -> tuple[dict, str]:
    """Exchange the code for a verified profile, and say where to send them.

    Raises OAuthError when Google itself misbehaves. Returns `(None, "")` in
    place of a profile when the request is merely stale or malformed, which
    the caller turns into a message rather than a 502.
    """

    env, query = ctx.env, ctx.query
    state, code = (query.get("state") or [None])[0], (query.get("code") or [None])[0]
    if not state or not code:
        return None, ""

    rows = await d1_rows(
        env.DB.prepare(f"SELECT code_verifier, next_url FROM {states_table} WHERE state = ?1 AND expires_at > ?2").bind(
            state, utc_timestamp()
        )
    )
    # Consumed whether or not it was valid: a state is good for one attempt.
    await env.DB.prepare(f"DELETE FROM {states_table} WHERE state = ?1").bind(state).run()
    if not rows:
        return None, ""

    token_payload = urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": rows[0]["code_verifier"],
        }
    )
    token = await fetch_json(
        "https://oauth2.googleapis.com/token",
        {"method": "POST", "headers": {"content-type": "application/x-www-form-urlencoded"}, "body": token_payload},
        OAuthError,
    )
    access_token = token.get("access_token")
    if not access_token:
        raise OAuthError("Google token exchange failed")

    profile = await fetch_json(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {"headers": {"Authorization": f"Bearer {access_token}"}},
        OAuthError,
    )
    # An unverified address is not proof of anything. Google will hand one
    # over for an account that merely typed it in.
    if profile.get("email_verified") is not True:
        return None, ""

    return profile, rows[0]["next_url"] or ""
