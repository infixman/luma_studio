"""Google sign-in and the session cookie for customers.

Only the public Worker imports this. Everything here is separate from
`auth_admin`: a different OAuth client, a different table, a different cookie
name. The point is that no amount of getting the storefront wrong can produce
an admin session, and that a leaked customer session is a customer's order
history rather than the keys to the shop.

Unlike the back office there is no allowlist. Anyone with a verified Google
address may have an account; what they may do with it is decided per request.
"""

import auth_core
from common import env_var, SESSION_ID_PATTERN, d1_rows, urlsafe_token, utc_timestamp
from responses import Ctx


SESSION_COOKIE_NAME = "luma_customer_session"
STATES_TABLE = "customer_oauth_states"
DEFAULT_PATH = "/shop"

CLIENT_ID, CLIENT_SECRET, REDIRECT_URI = "GOOGLE_CUSTOMER_CLIENT_ID", "GOOGLE_CUSTOMER_CLIENT_SECRET", "GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI"

# Longer than the admin's twelve hours. Being signed out mid-purchase costs a
# sale; being signed out of the back office costs one sign-in.
SESSION_TTL = 30 * 24 * 60 * 60

MAX_NAME = 60
MAX_PHONE = 20
MAX_ADDRESS = 200


def customer_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "displayName": row["display_name"],
        "recipientName": row["default_recipient_name"],
        "recipientPhone": row["default_recipient_phone"],
        "address": row["default_address"],
        "blocked": bool(row["blocked"]),
    }


async def current_customer(env, request) -> dict | None:
    session_id = auth_core.get_cookie(request, SESSION_COOKIE_NAME)
    if not session_id or not SESSION_ID_PATTERN.fullmatch(session_id):
        return None
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT c.* FROM customer_sessions s JOIN customers c ON c.id = s.customer_id"
            " WHERE s.session_id = ?1 AND s.expires_at > ?2"
        ).bind(session_id, utc_timestamp())
    )
    return customer_row(rows[0]) if rows else None


async def upsert_customer(env, google_sub: str, email: str, display_name: str) -> str:
    """Find the account behind a Google identity, creating it if new.

    Matched on `sub` rather than the address: someone who changes their Gmail
    address is still the same customer, and matching on email would hand them
    an empty order history.
    """

    now = utc_timestamp()
    rows = await d1_rows(env.DB.prepare("SELECT id FROM customers WHERE google_sub = ?1").bind(google_sub))
    if rows:
        customer_id = rows[0]["id"]
        await env.DB.prepare("UPDATE customers SET email = ?2, updated_at = ?3 WHERE id = ?1").bind(
            customer_id, email, now
        ).run()
        return customer_id

    customer_id = urlsafe_token(18)
    await env.DB.prepare(
        "INSERT INTO customers (id, google_sub, email, display_name, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
    ).bind(customer_id, google_sub, email, display_name, now).run()
    return customer_id


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

    google_sub = str(profile.get("sub") or "")
    email = str(profile.get("email") or "").lower()
    if not google_sub or not email:
        return ctx.error("Google did not return a usable profile", 502)

    customer_id = await upsert_customer(env, google_sub, email, str(profile.get("name") or "")[:MAX_NAME])
    session_id, now = urlsafe_token(), utc_timestamp()
    await env.DB.prepare("DELETE FROM customer_sessions WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare(
        "INSERT INTO customer_sessions (session_id, customer_id, expires_at) VALUES (?1, ?2, ?3)"
    ).bind(session_id, customer_id, now + SESSION_TTL).run()
    return ctx.redirect(
        auth_core.safe_return_url(ctx, next_url, DEFAULT_PATH),
        {"set-cookie": auth_core.session_cookie(SESSION_COOKIE_NAME, session_id, SESSION_TTL)},
    )


async def logout(ctx: Ctx):
    session_id = auth_core.get_cookie(ctx.request, SESSION_COOKIE_NAME)
    if session_id:
        await ctx.env.DB.prepare("DELETE FROM customer_sessions WHERE session_id = ?1").bind(session_id).run()
    return ctx.json(
        {"loggedOut": True}, extra_headers={"set-cookie": auth_core.session_cookie(SESSION_COOKIE_NAME, "", 0)}
    )


async def update_profile(env, customer_id: str, *, name: str, phone: str, address: str) -> None:
    await env.DB.prepare(
        "UPDATE customers SET default_recipient_name = ?2, default_recipient_phone = ?3,"
        " default_address = ?4, updated_at = ?5 WHERE id = ?1"
    ).bind(customer_id, name, phone, address, utc_timestamp()).run()
