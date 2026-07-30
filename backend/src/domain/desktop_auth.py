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
from hashlib import sha256

from shared import totp
from shared.common import ALLOWED_ADMIN_EMAILS, NotConfigured, env_var


PAIRING_SECRET_VAR = "DESKTOP_PAIRING_SECRET"

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

    address = normalise(email)
    if address not in ALLOWED_ADMIN_EMAILS:
        return False
    try:
        seed = seed_for(env, address)
    except NotConfigured:
        return False
    return totp.verify(seed, submitted, now=now)
