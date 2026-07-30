"""A short-lived bearer token with a signature over its own claims.

Two different features need the same thing: hand somebody a string that says
what they may do, that expires, that cannot be edited without invalidating
itself, and that reveals nothing when compared incorrectly. Playback tokens
were first; the desktop tool's are the second.

This exists rather than a second copy because the parts most easily got wrong
are the parts that must behave identically — constant-time comparison, base64
without padding, refusing a token minted in the future, accepting the previous
secret during a rotation. A bug fixed in one copy and not the other is a bug
that stays.

The `prefix` is a namespace, not decoration. Two features signing with
different secrets already cannot read each other's tokens, but a distinct
prefix means a token of the wrong kind is rejected before any comparison
happens, and it leaves room to change one format without touching the other.
"""

import base64
import hmac
import json
from hashlib import sha256


# Small tolerance for clock differences between isolates. Not a window for a
# token minted well ahead of time, which is not skew.
CLOCK_SKEW = 60


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(payload: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode("utf-8"), payload.encode("ascii"), sha256).digest())


def issue(claim: dict, *, prefix: str, secret: str, now: int, ttl: int) -> str:
    """Mint a token for exactly these claims.

    Always signed with the current secret. During a rotation the previous one
    still verifies, so nobody is cut off mid-task, but nothing new is ever
    signed with a key on its way out.
    """

    body = {**claim, "iat": now, "exp": now + ttl}
    payload = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    return f"{prefix}.{payload}.{_sign(payload, secret)}"


def _verify_with(token: str, prefix: str, secret: str, now: int) -> dict | None:
    try:
        version, payload, signature = token.split(".")
    except (ValueError, AttributeError):
        return None
    if version != prefix:
        return None

    # Constant time: a comparison that stops at the first wrong byte tells an
    # attacker how much of their guess was right, one request at a time.
    if not hmac.compare_digest(signature, _sign(payload, secret)):
        return None

    try:
        claim = json.loads(_unb64(payload))
    except (ValueError, TypeError):
        return None
    if not isinstance(claim, dict):
        return None

    expires_at, issued_at = claim.get("exp"), claim.get("iat")
    if not isinstance(expires_at, int) or not isinstance(issued_at, int):
        return None
    if now > expires_at:
        return None
    if issued_at > now + CLOCK_SKEW:
        return None
    return claim


def verify(token: str, *, prefix: str, secret: str, now: int, previous_secret: str | None = None) -> dict | None:
    """Read a token, or refuse it. None is the only failure signal.

    Callers get no detail about *why*: "expired" and "forged" are the same
    answer to somebody probing, and the difference belongs in a log rather than
    in a response.
    """

    if not secret:
        # An empty secret would make `_sign` a function of the payload alone,
        # which every caller could compute.
        return None
    claim = _verify_with(token, prefix, secret, now)
    if claim is not None:
        return claim
    # A rotation must not cut everybody off mid-task.
    if previous_secret:
        return _verify_with(token, prefix, previous_secret, now)
    return None
