"""Google OAuth login and the admin session cookie."""

import base64
import hashlib
from urllib.parse import urlencode

from common import (
    ALLOWED_ADMIN_EMAILS,
    OAUTH_STATE_TTL_SECONDS,
    SESSION_ID_PATTERN,
    SESSION_TTL_SECONDS,
    OAuthError,
    d1_rows,
    urlsafe_token,
    utc_timestamp,
)
from responses import Ctx, frontend_origin
from ibon import fetch_json


SESSION_COOKIE_NAME = "luma_admin_session"


def get_cookie(request, name: str) -> str | None:
    cookie_header = request.headers.get("Cookie") or ""
    for item in cookie_header.split(";"):
        key, separator, value = item.strip().partition("=")
        if separator and key == name:
            return value
    return None


def session_cookie(session_id: str, max_age: int) -> str:
    """Session cookie for the admin API.

    The frontend (luma-studio.tw) and this API (api.luma-studio.tw) share a
    registrable domain, so requests between them are same-site and Lax is
    enough. Lax also means a cross-site POST cannot carry the cookie at all,
    which is a stronger position than the SameSite=None this needed while the
    two halves lived on separate workers.dev hosts.

    `Ctx.has_csrf_protection` still enforces the Origin allowlist and the
    preflight-forcing header, because the two origins differ even though the
    site does not.
    """

    return f"{SESSION_COOKIE_NAME}={session_id}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"


async def get_admin_email(env, request) -> str | None:
    session_id = get_cookie(request, SESSION_COOKIE_NAME)
    if not session_id or not SESSION_ID_PATTERN.fullmatch(session_id):
        return None
    rows = await d1_rows(env.DB.prepare("SELECT email FROM admin_sessions WHERE session_id = ?1 AND expires_at > ?2").bind(session_id, utc_timestamp()))
    return rows[0]["email"] if rows else None


def safe_return_url(ctx: Ctx, candidate: str) -> str:
    """Only ever send the browser back to a configured frontend origin."""

    default = f"{frontend_origin(ctx.env)}/admin"
    if not candidate:
        return default
    for origin in ctx.allowed_origins:
        if candidate == origin or candidate.startswith(f"{origin}/"):
            return candidate
    return default


async def begin_google_login(ctx: Ctx):
    state, verifier = urlsafe_token(), urlsafe_token(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    now = utc_timestamp()
    next_url = safe_return_url(ctx, (ctx.query.get("next") or [""])[0])
    env = ctx.env
    await env.DB.prepare("DELETE FROM admin_oauth_states WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare("INSERT INTO admin_oauth_states (state, code_verifier, next_url, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(state, verifier, next_url, now + OAUTH_STATE_TTL_SECONDS).run()
    query = urlencode({"client_id": env.GOOGLE_CLIENT_ID, "redirect_uri": env.GOOGLE_OAUTH_REDIRECT_URI, "response_type": "code", "scope": "openid email profile", "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "prompt": "select_account"})
    return ctx.redirect(f"https://accounts.google.com/o/oauth2/v2/auth?{query}")


async def complete_google_login(ctx: Ctx):
    env, query = ctx.env, ctx.query
    state, code = (query.get("state") or [None])[0], (query.get("code") or [None])[0]
    if not state or not code:
        return ctx.error("Google login was cancelled or invalid", 400)
    rows = await d1_rows(env.DB.prepare("SELECT code_verifier, next_url FROM admin_oauth_states WHERE state = ?1 AND expires_at > ?2").bind(state, utc_timestamp()))
    await env.DB.prepare("DELETE FROM admin_oauth_states WHERE state = ?1").bind(state).run()
    if not rows:
        return ctx.error("Google login expired; try again", 400)
    token_payload = urlencode({"code": code, "client_id": env.GOOGLE_CLIENT_ID, "client_secret": env.GOOGLE_CLIENT_SECRET, "redirect_uri": env.GOOGLE_OAUTH_REDIRECT_URI, "grant_type": "authorization_code", "code_verifier": rows[0]["code_verifier"]})
    token = await fetch_json("https://oauth2.googleapis.com/token", {"method": "POST", "headers": {"content-type": "application/x-www-form-urlencoded"}, "body": token_payload}, OAuthError)
    access_token = token.get("access_token")
    if not access_token:
        raise OAuthError("Google token exchange failed")
    profile = await fetch_json("https://openidconnect.googleapis.com/v1/userinfo", {"headers": {"Authorization": f"Bearer {access_token}"}}, OAuthError)
    email = str(profile.get("email") or "").lower()
    if profile.get("email_verified") is not True or email not in ALLOWED_ADMIN_EMAILS:
        return ctx.error("This Google account is not authorized", 403)
    session_id, now = urlsafe_token(), utc_timestamp()
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare("INSERT INTO admin_sessions (session_id, email, expires_at) VALUES (?1, ?2, ?3)").bind(session_id, email, now + SESSION_TTL_SECONDS).run()
    return ctx.redirect(safe_return_url(ctx, rows[0]["next_url"] or ""), {"set-cookie": session_cookie(session_id, SESSION_TTL_SECONDS)})


async def logout(ctx: Ctx):
    session_id = get_cookie(ctx.request, SESSION_COOKIE_NAME)
    if session_id:
        await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE session_id = ?1").bind(session_id).run()
    return ctx.json({"loggedOut": True}, extra_headers={"set-cookie": session_cookie("", 0)})
