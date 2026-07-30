"""Pairing a desktop tool with an admin, without storing anything.

The tool needs to prove it was launched by somebody who can see the back
office. The back office shows six digits; the tool submits them with an email
address and gets a token scoped to video work.

**The seed is derived, not stored.** It is an HMAC of a Worker secret and the
admin's email address, which removes a whole row of problems rather than solving
them: there is no table to migrate, no seed to show once and hope was written
down, no D1 dump containing seeds, and rotation is one value changing rather
than a migration. Each admin still gets their own seed, because the address is
part of the derivation.

That derivation is also the revocation mechanism. Changing
`DESKTOP_PAIRING_SECRET` invalidates every pairing at once; removing somebody
from the admin allowlist stops them pairing at all, because the allowlist is
checked here and not only at login.

An empty secret would derive a seed anybody could compute, so a missing one is a
refusal rather than a default.
"""

import base64
import hmac
import re
from hashlib import sha256

from shared import signed_token, totp
from shared.common import ALLOWED_ADMIN_EMAILS, NotConfigured, d1_changed, d1_rows, env_var


PAIRING_SECRET_VAR = "DESKTOP_PAIRING_SECRET"
TOKEN_SECRET_VAR = "DESKTOP_TOKEN_SECRET"

# Its own prefix, so a playback token is refused here before any comparison and
# a change to either format leaves the other alone.
TOKEN_PREFIX = "dv1"

# One working session. Long enough that a two-hour upload does not stop halfway,
# short enough that a laptop left on a train stops being useful the same day.
TOKEN_TTL = 12 * 60 * 60

SCOPE_VIDEO = "video"

# What a wrong code costs, and what it costs to keep guessing. Six digits is a
# million combinations, so this — not the code's secrecy — is what stands
# between an attacker and the whole space.
#
# The per-IP rate limiter cannot do this job: it is advisory, it fails open when
# the binding is absent, and rotating addresses defeats it. This counts per
# account and fails closed.
MAX_FAILURES = 5
LOCK_SECONDS = 15 * 60

# Exactly what getting a video into the library takes: make the row, ask for
# URLs, register the result. Listed rather than derived from a prefix, because
# `/api/video-assets` also answers GET (the library) and POST .../archive
# (retirement), and neither of those is uploading.
_VIDEO_ROUTES = (
    ("POST", re.compile(r"^/api/video-assets$")),
    ("POST", re.compile(r"^/api/video-assets/import$")),
    ("POST", re.compile(r"^/api/video-assets/[A-Za-z0-9_-]{1,64}/upload-urls$")),
    # The original file goes up in parts, which is three more routes the tool
    # drives. Opening a session and signing a part are part of uploading in the
    # same sense `upload-urls` is; ending one is on the list because the tool is
    # the only thing that knows the upload finished.
    ("POST", re.compile(r"^/api/video-assets/[A-Za-z0-9_-]{1,64}/source-upload$")),
    (
        "POST",
        re.compile(r"^/api/video-assets/[A-Za-z0-9_-]{1,64}/source-upload/[A-Za-z0-9_-]{1,64}/parts/\d{1,5}$"),
    ),
    # The FFmpeg mirror. Part of uploading rather than a separate permission: the
    # tool reaches it with an MP4 already dropped on it and no FFmpeg to encode
    # with. The bytes are a published GPL build and not a secret — what the token
    # protects is our bandwidth.
    ("GET", re.compile(r"^/tools/ffmpeg/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")),
)

SCOPES = {SCOPE_VIDEO: _VIDEO_ROUTES}

# Distinguishes this use of the secret from any later one. Two features deriving
# keys from the same value with no separation means one of them can produce the
# other's.
PURPOSE = "desktop-pairing-v1"


def normalise(email) -> str:
    """The address as the session table holds it.

    Login lowercases before storing. A caller who sends mixed case would
    otherwise derive a second seed for one person, and the symptom is a correct
    code that never matches.
    """

    return str(email or "").strip().lower()


def seed_for(env, email: str) -> str:
    """This admin's TOTP seed, derived rather than looked up."""

    secret = env_var(env, PAIRING_SECRET_VAR)
    if not secret:
        raise NotConfigured("桌面工具配對尚未設定")
    digest = hmac.new(
        secret.encode("utf-8"), f"{PURPOSE}:{normalise(email)}".encode("utf-8"), sha256
    ).digest()
    # Base32 without padding, so the same seed could be handed to an
    # authenticator app later without reformatting it.
    return base64.b32encode(digest[: totp.SECRET_BYTES]).decode("ascii").rstrip("=")


def pairing_code(env, email: str, *, now: int) -> dict:
    """What the back office shows.

    The remaining seconds go with it. Without them somebody types a code with
    two seconds left and is told their correct code was wrong.
    """

    return {
        "code": totp.code_at(seed_for(env, email), now),
        "expiresInSeconds": totp.seconds_left(now),
        "adminEmail": normalise(email),
    }


def verify_pairing(env, email, submitted, *, now: int) -> bool:
    """Whether this code pairs this admin, right now.

    Reached without a session, so two things are checked here that are usually
    somebody else's job. The allowlist, because deriving a seed for an arbitrary
    address would hand a working code to anybody who asked for one. And the
    configuration, because an unconfigured Worker has to refuse rather than
    raise — a 500 here would announce a misconfiguration to a stranger.

    Every failure is False. "Not an admin", "wrong code" and "no secret" are one
    answer, and the difference belongs in a log.
    """

    return _matching_counter(env, email, submitted, now=now) is not None


def _matching_counter(env, email, submitted, *, now: int) -> int | None:
    """Which window this code is for, if it is this admin's at all."""

    address = normalise(email)
    if address not in ALLOWED_ADMIN_EMAILS:
        return None
    try:
        seed = seed_for(env, address)
    except NotConfigured:
        return None
    return totp.matching_counter(seed, submitted, now=now)


def scope_allows(scope: str, method: str, path: str) -> bool:
    """Whether a token of this scope may reach this route.

    An allowlist, and not a default. A desktop token is a real identity with a
    deliberately small permission, so a route nobody thought about is refused
    rather than inherited — and a new scope has to say what it opens.
    """

    return any(
        method == allowed_method and pattern.fullmatch(path or "")
        for allowed_method, pattern in SCOPES.get(scope, ())
    )


def bearer_token(request) -> str:
    header = request.headers.get("Authorization") or ""
    prefix = "Bearer "
    return header[len(prefix) :].strip() if header.startswith(prefix) else ""


def read_token(env, token: str, *, now: int) -> dict | None:
    """The claims in a desktop token, or None.

    None for every kind of failure. A caller probing this learns nothing about
    whether a token was expired, forged, or for something else.
    """

    claim = signed_token.verify(
        token, prefix=TOKEN_PREFIX, secret=env_var(env, TOKEN_SECRET_VAR), now=now
    )
    if not claim:
        return None
    email, scope = claim.get("adminEmail"), claim.get("scope")
    # Re-checked at every request rather than trusted from issue time. Removing
    # somebody from the allowlist has to take effect before their token expires.
    if scope not in SCOPES or normalise(email) not in ALLOWED_ADMIN_EMAILS:
        return None
    return {"adminEmail": normalise(email), "scope": scope}


async def _pairing_row(env, email: str) -> dict | None:
    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM desktop_pairings WHERE email = ?1").bind(email)
    )
    return rows[0] if rows else None


async def _record_failure(env, email: str, row: dict | None, *, now: int) -> None:
    """Count a wrong code, and lock the account once there have been enough.

    Counted per account rather than per address, because an attacker with a
    million guesses to make has more than one address.
    """

    failures = int((row or {}).get("failures") or 0) + 1
    locked_until = now + LOCK_SECONDS if failures >= MAX_FAILURES else 0
    await env.DB.prepare(
        "INSERT INTO desktop_pairings (email, used_counter, failures, locked_until, updated_at)"
        " VALUES (?1, NULL, ?2, ?3, ?4)"
        " ON CONFLICT(email) DO UPDATE SET failures = ?2, locked_until = ?3, updated_at = ?4"
    ).bind(email, failures, locked_until, now).run()


# A module constant so the SQLite test can exercise this exact statement. A
# fake database cannot evaluate the WHERE clause, and a test holding its own
# copy of the SQL would keep passing after this one changed.
CONSUME_SQL = (
    "INSERT INTO desktop_pairings (email, used_counter, failures, locked_until, updated_at)"
    " VALUES (?1, ?2, 0, 0, ?3)"
    " ON CONFLICT(email) DO UPDATE SET used_counter = ?2, failures = 0, locked_until = 0,"
    " updated_at = ?3"
    " WHERE desktop_pairings.used_counter IS NULL OR desktop_pairings.used_counter < ?2"
)


async def _consume(env, email: str, counter: int, *, now: int) -> bool:
    """Spend this window, if it has not been spent.

    The WHERE clause is the race guard, not the check — the check happened
    against the row that was read. Both are needed for the same reason
    everything else here does it: one answers "is this a sensible move", the
    other answers "is the row still where we read it".

    Spending also clears the failure count and any lock. A correct code ends
    that episode; leaving the count where it was would lock the admin out on
    their next typo.
    """

    result = await env.DB.prepare(CONSUME_SQL).bind(email, counter, now).run()
    return d1_changed(result)


async def exchange(env, *, email, code, now: int) -> dict | None:
    """Spend a pairing code for a token scoped to video work.

    Reached without a session, so this is the exposed surface. Three things make
    it survivable and none of them is the code being hard to guess:

    A code works once. Its window is thirty seconds and it is displayed on a
    screen, so without that, one glance is repeatable for half a minute.

    An older window cannot be replayed after a newer one has been spent.
    Accepting the previous window is for clock skew, not for going backwards.

    Wrong codes are counted and the account locks. Even the correct code is
    refused while locked, because the lock is on the account and not the guess.

    None for every failure. "Not an admin", "wrong code", "already used" and
    "locked" are one answer; the difference belongs in a log.
    """

    address = normalise(email)
    if address not in ALLOWED_ADMIN_EMAILS:
        # Before any write, so a stranger cannot fill the table with rows.
        return None

    secret = env_var(env, TOKEN_SECRET_VAR)
    if not secret:
        # An unsigned token that looks signed is worse than a refusal.
        return None

    row = await _pairing_row(env, address)
    if int((row or {}).get("locked_until") or 0) > now:
        return None

    counter = _matching_counter(env, address, code, now=now)
    if counter is None:
        await _record_failure(env, address, row, now=now)
        return None

    spent = (row or {}).get("used_counter")
    if spent is not None and counter <= int(spent):
        return None
    if not await _consume(env, address, counter, now=now):
        return None

    return {
        "token": signed_token.issue(
            {"adminEmail": address, "scope": SCOPE_VIDEO},
            prefix=TOKEN_PREFIX,
            secret=secret,
            now=now,
            ttl=TOKEN_TTL,
        ),
        "expiresAt": now + TOKEN_TTL,
        "scope": SCOPE_VIDEO,
        "adminEmail": address,
    }
