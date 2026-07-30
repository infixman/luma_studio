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

from shared import signed_token


# In the token, first, so a later format change cannot be replayed against a
# server that would misread the old shape as the new one.
TOKEN_VERSION = 1
PREFIX = f"v{TOKEN_VERSION}"

# Long enough not to interrupt a lesson, short enough that revoking access
# means something. The player refreshes before it lapses.
DEFAULT_TTL = 15 * 60

SECONDS_PER_DAY = 86400

# What the gateway may serve is `video.allowed_object`, which is the same list
# the signer uses to decide what may be written. It lives there because an
# object's name is a property of the encode, not of the token that opens it —
# and a second copy here would be one edit away from the gateway refusing to
# serve something the pipeline was allowed to upload.


def issue(claim: dict, *, secret: str, now: int, ttl: int = DEFAULT_TTL) -> str:
    """Mint a token for one member, one lesson, one encode.

    `v` stays inside the claims as well as in the prefix. It was there before
    the signing moved to `shared.signed_token`, and removing it would change
    the payload of tokens members are already holding.
    """

    return signed_token.issue(
        {**claim, "v": TOKEN_VERSION}, prefix=PREFIX, secret=secret, now=now, ttl=ttl
    )


def verify(token: str, *, secret: str, now: int, previous_secret: str | None = None) -> dict | None:
    """Read a token, or refuse it. None is the only failure signal."""

    return signed_token.verify(
        token, prefix=PREFIX, secret=secret, now=now, previous_secret=previous_secret
    )


def covers(claim: dict | None, *, asset_id: str, encode_version: int) -> bool:
    """Whether this token is for this exact object.

    One lesson's token opening the rest of the course would make the whole
    check ornamental, and a token for an old encode must not reach into a new
    one — the version is part of what was authorised.
    """

    if not claim:
        return False
    return claim.get("assetId") == asset_id and claim.get("encodeVersion") == encode_version


def expiry_for(*, access_days: int | None, first_viewed_at: int | None, now: int) -> dict | None:
    """When a timed grant should start counting, if it has not already.

    None means "leave it alone", which covers both the permanent grant and the
    one already running. Every playback calls this; restarting the window on
    each would quietly make a timed course permanent.
    """

    if access_days is None or first_viewed_at is not None:
        return None
    return {"firstViewedAt": now, "expiresAt": now + access_days * SECONDS_PER_DAY}
