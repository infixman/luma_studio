"""Time-based codes, used as a pairing code rather than as a second factor.

The desktop tool has to prove it was launched by somebody who can see the back
office. It cannot hold an admin session — that would put a credential worth
stealing on a laptop — and asking it to run a browser login would amount to the
same thing. So the back office shows six digits and the tool submits them.

The server both shows and verifies the code, which means this buys no secrecy.
What it buys is a *time bound with no stored state*: a code works for its window
and then it does not, so "can see the back office" and "can authorise one
machine" become the same permission. Nothing has to be issued, tracked or
cleaned up.

RFC 6238, SHA-1, six digits, thirty-second step, base32 seed — the shape an
authenticator app expects. Nothing needs that today, and it costs nothing to
keep the option of provisioning one and skipping the page.

The seed is the real secret. It never leaves the server, and it is shown to the
admin once when it is created.
"""

import base64
import hmac
from hashlib import sha1

from shared.common import secure_bytes


STEP = 30
DIGITS = 6

# Twenty bytes, matching SHA-1's block arithmetic and what authenticator apps
# expect. Base32 turns this into 32 characters.
SECRET_BYTES = 20

# How far back a code is still accepted. One step, for the clock difference
# between a laptop and an isolate plus the seconds it takes to type six digits.
#
# Deliberately not symmetrical: accepting the *next* window would widen the
# guessing range by half again for nothing, because the admin is reading a code
# generated from the same clock this verifies against.
BACKWARD_STEPS = 1


def new_secret() -> str:
    """A fresh seed, base32 without padding.

    Padding is stripped because an authenticator app's QR payload and most
    manual-entry fields reject it, and `b32decode` can put it back.
    """

    return base64.b32encode(secure_bytes(SECRET_BYTES)).decode("ascii").rstrip("=")


def _decode(secret) -> bytes | None:
    """The seed as bytes, or None if it is not a usable one.

    None rather than an exception: this is read from a database, and a row that
    got corrupted should refuse pairings instead of turning every request into
    a 500.
    """

    if not isinstance(secret, str) or not secret:
        return None
    padded = secret.strip().upper()
    padded += "=" * (-len(padded) % 8)
    try:
        raw = base64.b32decode(padded, casefold=True)
    except (ValueError, TypeError):
        return None
    return raw or None


def _code_for_counter(raw: bytes, counter: int) -> str:
    """HOTP, RFC 4226. The dynamic truncation is the whole of the algorithm."""

    digest = hmac.new(raw, counter.to_bytes(8, "big"), sha1).digest()
    offset = digest[-1] & 0x0F
    chunk = int.from_bytes(digest[offset : offset + 4], "big")
    return str((chunk & 0x7FFFFFFF) % 10**DIGITS).zfill(DIGITS)


def code_at(secret: str, instant: int) -> str:
    """The code for the window containing this instant.

    Raises on an unusable seed, unlike `verify`, which returns False. This one
    is called to *show* a code to an admin who is signed in, and a corrupt seed
    there is a real fault worth surfacing rather than an empty box. `verify` is
    called by a stranger, who must not be able to tell "no seed" from "wrong
    code".
    """

    raw = _decode(secret)
    if raw is None:
        raise ValueError("Unusable TOTP secret")
    return _code_for_counter(raw, instant // STEP)


def seconds_left(instant: int) -> int:
    """How much of the current window remains.

    Shown next to the code. Without it somebody typing a code with two seconds
    left gets told their correct code was wrong.
    """

    return STEP - instant % STEP


def verify(secret, submitted, *, now: int) -> bool:
    """Whether this is the code for now, or for the window just before it.

    Every failure is False, including an unusable seed — a caller must not be
    able to tell "no seed" from "wrong code", and there is nothing useful to do
    differently.
    """

    raw = _decode(secret)
    if raw is None:
        return False
    # `isascii` is not decoration. `"１２３４５６".isdigit()` is true, and
    # `compare_digest` raises on a non-ASCII string rather than returning False
    # — so without this, six full-width digits are a 500 instead of a refusal.
    if not isinstance(submitted, str) or len(submitted) != DIGITS:
        return False
    if not submitted.isascii() or not submitted.isdigit():
        return False

    counter = now // STEP
    for step in range(BACKWARD_STEPS + 1):
        # Constant time. Six digits is a million guesses, and a comparison that
        # stops at the first wrong one turns that into six times ten — which
        # would leave the attempt limit as the only thing standing there.
        if hmac.compare_digest(submitted, _code_for_counter(raw, counter - step)):
            return True
    return False
