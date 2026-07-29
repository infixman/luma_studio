"""Letting a member watch, and nobody else.

Access is checked once, when a playback token is issued, and not again on
every segment. A lesson is hundreds of segment requests; a database round trip
on each would cost more than it protects. The token's short life is what
bounds the damage instead — revoking access takes effect when the current
token runs out, which is minutes, not never.

A token is therefore a bearer credential, and the useful properties are the
boring ones: it names exactly which object it covers, it expires, it cannot be
edited without invalidating itself, and comparing it does not leak how nearly
correct a guess was.

What this is not is DRM. A member who may watch can record what they watch.
The goal is that people who may not watch cannot, and that a URL shared out of
context stops working quickly.
"""

import base64
import hmac
import json
import re
from hashlib import sha256


# In the token, first, so a later format change cannot be replayed against a
# server that would misread the old shape as the new one.
TOKEN_VERSION = 1

# Long enough not to interrupt a lesson, short enough that revoking access
# means something. The player refreshes before it lapses.
DEFAULT_TTL = 15 * 60

# Small tolerance for clock differences between isolates. Not a window for a
# token minted well ahead of time, which is not skew.
CLOCK_SKEW = 60

SECONDS_PER_DAY = 86400

# Exactly the shapes the encoder writes. Anything else is either an attempt to
# reach a different object or a bug that would 404 anyway.
OBJECT_PATTERNS = (
    re.compile(r"^master\.m3u8$"),
    re.compile(r"^poster\.webp$"),
    re.compile(r"^(?:1080p|720p|480p)/playlist\.m3u8$"),
    re.compile(r"^(?:1080p|720p|480p)/init\.mp4$"),
    re.compile(r"^(?:1080p|720p|480p)/segment-\d{6}\.m4s$"),
)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(payload: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode("utf-8"), payload.encode("ascii"), sha256).digest())


def issue(claim: dict, *, secret: str, now: int, ttl: int = DEFAULT_TTL) -> str:
    """Mint a token for one member, one lesson, one encode.

    Always signed with the current secret. During a rotation the previous one
    still *verifies*, so nobody is signed out mid-lesson, but nothing new is
    ever signed with a key that is on its way out.
    """

    body = {**claim, "v": TOKEN_VERSION, "iat": now, "exp": now + ttl}
    payload = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    return f"v{TOKEN_VERSION}.{payload}.{_sign(payload, secret)}"


def _verify_with(token: str, secret: str, now: int) -> dict | None:
    try:
        version, payload, signature = token.split(".")
    except (ValueError, AttributeError):
        return None
    if version != f"v{TOKEN_VERSION}":
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


def verify(token: str, *, secret: str, now: int, previous_secret: str | None = None) -> dict | None:
    """Read a token, or refuse it. None is the only failure signal.

    Callers get no detail about *why*: "expired" and "forged" are the same
    answer to somebody probing, and the difference is in the log rather than
    in the response.
    """

    claim = _verify_with(token, secret, now)
    if claim is not None:
        return claim
    # A rotation must not sign every member out in the middle of a lesson.
    if previous_secret:
        return _verify_with(token, previous_secret, now)
    return None


def covers(claim: dict | None, *, asset_id: str, encode_version: int) -> bool:
    """Whether this token is for this exact object.

    One lesson's token opening the rest of the course would make the whole
    check ornamental, and a token for an old encode must not reach into a new
    one — the version is part of what was authorised.
    """

    if not claim:
        return False
    return claim.get("assetId") == asset_id and claim.get("encodeVersion") == encode_version


def allowed_object(path: str) -> bool:
    """Whether the gateway will serve this path at all.

    An allowlist of the shapes the encoder writes, not a denylist of traversal
    tricks. Every list of tricks is missing one, and the object names here are
    entirely predictable, so there is no reason to accept anything else.
    """

    if not isinstance(path, str) or not path:
        return False
    return any(pattern.fullmatch(path) for pattern in OBJECT_PATTERNS)


def expiry_for(*, access_days: int | None, first_viewed_at: int | None, now: int) -> dict | None:
    """When a timed grant should start counting, if it has not already.

    None means "leave it alone", which covers both the permanent grant and the
    one already running. Every playback calls this; restarting the window on
    each would quietly make a timed course permanent.
    """

    if access_days is None or first_viewed_at is not None:
        return None
    return {"firstViewedAt": now, "expiresAt": now + access_days * SECONDS_PER_DAY}
