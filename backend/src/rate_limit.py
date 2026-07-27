"""Per-IP limits on the endpoints an outsider can reach.

Three of the public routes cost real resources when hit repeatedly:

* `/auth/login` writes a row to `admin_oauth_states` on every request, with no
  authentication and nothing to deduplicate against. The D1 write quota is
  shared with the session table, so hammering it locks the admin out.
* `/api/print/{id}` and `/ibon_print/{id}` read up to 15 MB from R2 and run a
  four-step upload to ibon whenever the 24-hour cache is cold.
* The bio link page and its redirects read D1 on every visit.

Limits are advisory: if the binding is missing or the call fails, requests are
allowed through. A rate limiter that can take the site down is worse than the
abuse it prevents.
"""

from common import js_options


LOGIN = "LOGIN_LIMITER"
PRINT = "PRINT_LIMITER"
PUBLIC = "PUBLIC_LIMITER"


def client_key(request, scope: str) -> str:
    """Identify the caller for limiting purposes.

    Cloudflare sets CF-Connecting-IP itself and it cannot be spoofed by the
    client. Without it there is nothing trustworthy to key on, so the caller
    goes unlimited rather than being lumped in with everyone else.
    """

    ip = request.headers.get("CF-Connecting-IP") or ""
    return f"{scope}:{ip}" if ip else ""


async def allows(env, binding_name: str, request, scope: str) -> bool:
    limiter = getattr(env, binding_name, None)
    key = client_key(request, scope)
    if limiter is None or not key:
        return True
    try:
        outcome = await limiter.limit(js_options({"key": key}))
        return bool(outcome.success)
    except Exception:
        return True
