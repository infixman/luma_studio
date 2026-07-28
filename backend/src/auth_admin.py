"""Google sign-in and the session cookie for the back office.

Only the admin Worker imports this. The storefront's customer login is
`auth_customer`, with its own table, its own OAuth client and its own cookie
name, so that a handler holding one can never be mistaken for a handler
holding the other.
"""

import auth_core
from common import env_var, ALLOWED_ADMIN_EMAILS, SESSION_ID_PATTERN, SESSION_TTL_SECONDS, d1_rows, urlsafe_token, utc_timestamp
from responses import Ctx


SESSION_COOKIE_NAME = "luma_admin_session"
STATES_TABLE = "admin_oauth_states"
DEFAULT_PATH = "/"

CLIENT_ID, CLIENT_SECRET, REDIRECT_URI = "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"


async def get_admin_email(env, request) -> str | None:
    session_id = auth_core.get_cookie(request, SESSION_COOKIE_NAME)
    if not session_id or not SESSION_ID_PATTERN.fullmatch(session_id):
        return None
    rows = await d1_rows(
        env.DB.prepare("SELECT email FROM admin_sessions WHERE session_id = ?1 AND expires_at > ?2").bind(
            session_id, utc_timestamp()
        )
    )
    return rows[0]["email"] if rows else None


def settings(env) -> dict:
    return {name: env_var(env, name) for name in (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)}


async def begin_google_login(ctx: Ctx):
    configured = settings(ctx.env)
    missing = auth_core.missing_settings(configured)
    if missing:
        return ctx.error(f"Backend is missing {', '.join(missing)}", 500)
    return await auth_core.begin_login(
        ctx,
        states_table=STATES_TABLE,
        client_id=configured[CLIENT_ID],
        redirect_uri=configured[REDIRECT_URI],
        default_path=DEFAULT_PATH,
    )


async def complete_google_login(ctx: Ctx):
    env = ctx.env
    configured = settings(env)
    missing = auth_core.missing_settings(configured)
    if missing:
        return ctx.error(f"Backend is missing {', '.join(missing)}", 500)
    profile, next_url = await auth_core.complete_login(
        ctx,
        states_table=STATES_TABLE,
        client_id=configured[CLIENT_ID],
        client_secret=configured[CLIENT_SECRET],
        redirect_uri=configured[REDIRECT_URI],
    )
    if profile is None:
        return ctx.error("Google login was cancelled or expired; try again", 400)

    email = str(profile.get("email") or "").lower()
    # An allowlist, not a role column. This deployment has exactly two people
    # who may use it, and that is worth stating rather than administering.
    if email not in ALLOWED_ADMIN_EMAILS:
        return ctx.error("This Google account is not authorized", 403)

    session_id, now = urlsafe_token(), utc_timestamp()
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare("INSERT INTO admin_sessions (session_id, email, expires_at) VALUES (?1, ?2, ?3)").bind(
        session_id, email, now + SESSION_TTL_SECONDS
    ).run()
    return ctx.redirect(
        auth_core.safe_return_url(ctx, next_url, DEFAULT_PATH),
        {"set-cookie": auth_core.session_cookie(SESSION_COOKIE_NAME, session_id, SESSION_TTL_SECONDS)},
    )


async def logout(ctx: Ctx):
    session_id = auth_core.get_cookie(ctx.request, SESSION_COOKIE_NAME)
    if session_id:
        await ctx.env.DB.prepare("DELETE FROM admin_sessions WHERE session_id = ?1").bind(session_id).run()
    return ctx.json(
        {"loggedOut": True}, extra_headers={"set-cookie": auth_core.session_cookie(SESSION_COOKIE_NAME, "", 0)}
    )
