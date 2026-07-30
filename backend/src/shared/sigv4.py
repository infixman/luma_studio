"""AWS SigV4 query signing, for handing out short-lived R2 upload URLs.

The bytes of a course video never pass through this Worker — a two-hour lesson
is not a request body. What the Worker hands out instead is a URL that R2 will
accept for exactly one object, one method and a few minutes, which means this
module is the whole of the boundary: everything the desktop tool can do to the
buckets is something signed here.

So the design is narrow on purpose. The caller names a method from a short
list, a bucket and a key; there is no way to ask for a URL that covers a
prefix, a second object, or an operation nobody thought about.

A presigned URL is a bearer credential. It goes in no log, and it is not the
kind of thing to give a generous lifetime to.

The signature is either byte-identical to what AWS specifies or R2 answers 403
with nothing useful in it, so the tests check parity against a real
implementation rather than checking that the code does what the code does.
"""

import hmac
from datetime import datetime, timezone
from hashlib import sha256
from urllib.parse import quote


ALGORITHM = "AWS4-HMAC-SHA256"

# R2 has one region and it is spelled this way. Sending anything else produces
# a signature mismatch rather than a helpful message.
REGION = "auto"
SERVICE = "s3"

# The body is not signed. For an upload that is the only workable choice — the
# signer does not have the bytes, and could not hash gigabytes if it did.
UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

# Reading and writing one named object, and asking whether it arrived. A
# presigned DELETE is not on this list because deletion is the back office's
# job, where the reference checks live.
METHODS = ("GET", "HEAD", "PUT")

# AWS refuses anything longer. Ours are minutes, but the bound belongs here so
# a caller's arithmetic mistake fails at the signer rather than at R2.
MAX_EXPIRES = 7 * 24 * 60 * 60

# Only the host is signed. Every other header is therefore free to differ
# between the signer and whatever eventually sends the request, which is what
# lets a desktop tool use a URL a Worker produced.
SIGNED_HEADERS = "host"


def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), sha256).digest()


def _hexdigest(message: str) -> str:
    return sha256(message.encode("utf-8")).hexdigest()


def _encode(value: str) -> str:
    """Percent-encode for a canonical query string.

    RFC 3986 unreserved characters stay as they are and everything else is
    encoded, including `/`. `quote`'s default safe set is `/`, which is exactly
    the wrong answer here and produces a signature that verifies nowhere.
    """

    return quote(value, safe="-_.~")


def _canonical_path(bucket: str, key: str) -> str:
    """The signed path, refusing shapes that could mean two different objects.

    A leading slash, an empty segment or a `..` can be read one way by the
    signer and another by R2, and the entire value of signing a path is that
    both agree on which object was granted. Callers build keys from ids, so
    anything like this is a bug or an attempt at one.

    The bucket gets the same treatment even though it comes from configuration
    rather than a request. `_encode` leaves `.` alone, so a bucket of `..`
    would put a traversal in the path — cheaper to refuse here than to reason
    about every future caller.
    """

    if not isinstance(key, str) or not key:
        raise ValueError("Object key is required")
    if not isinstance(bucket, str) or not bucket:
        raise ValueError("Bucket is required")

    segments = [bucket, *key.split("/")]
    if key.startswith("/") or any(segment in ("", "..", ".") for segment in segments):
        raise ValueError("Object key must be a plain relative path")
    return "/".join(_encode(segment) for segment in segments)


def presigned_url(
    *,
    method: str,
    endpoint: str,
    bucket: str,
    key: str,
    access_key_id: str,
    secret_access_key: str,
    now: int,
    expires: int,
    region: str = REGION,
) -> str:
    """A URL R2 will honour for this one object, method and window.

    `now` is passed in rather than read from the clock so the result is a
    function of its arguments — the same reason the playback tokens take it.
    """

    if method not in METHODS:
        raise ValueError(f"Cannot presign {method}")
    if not access_key_id or not secret_access_key:
        raise ValueError("R2 signing credentials are not configured")
    if isinstance(expires, bool) or not isinstance(expires, int) or expires < 1 or expires > MAX_EXPIRES:
        raise ValueError(f"Expiry must be between 1 and {MAX_EXPIRES} seconds")

    # Host only. An endpoint carrying a path would be signed as part of the
    # Host header, which R2 reads as a different host entirely — a
    # misconfiguration that would otherwise surface as an unexplained 403.
    host = str(endpoint).split("://", 1)[-1].strip("/")
    if not host or "/" in host:
        raise ValueError("R2 endpoint must be a scheme and host only")

    path = _canonical_path(bucket, key)
    moment = datetime.fromtimestamp(now, timezone.utc)
    amz_date = moment.strftime("%Y%m%dT%H%M%SZ")
    day = moment.strftime("%Y%m%d")
    scope = f"{day}/{region}/{SERVICE}/aws4_request"

    # Sorted *after* encoding, because that is how the canonical form is
    # defined. The five names here encode to themselves, so today it makes no
    # difference — but a later parameter with a character that encodes would
    # sort into a different place, and the failure would be a 403 with nothing
    # in it. `X-Amz-Signature` is deliberately absent: it is the output of
    # this, so signing it would be circular.
    query = "&".join(
        f"{name}={value}"
        for name, value in sorted(
            (_encode(name), _encode(value))
            for name, value in (
                ("X-Amz-Algorithm", ALGORITHM),
                ("X-Amz-Credential", f"{access_key_id}/{scope}"),
                ("X-Amz-Date", amz_date),
                ("X-Amz-Expires", str(expires)),
                ("X-Amz-SignedHeaders", SIGNED_HEADERS),
            )
        )
    )

    canonical_request = "\n".join(
        (method, f"/{path}", query, f"host:{host}\n", SIGNED_HEADERS, UNSIGNED_PAYLOAD)
    )
    to_sign = "\n".join((ALGORITHM, amz_date, scope, _hexdigest(canonical_request)))

    signing_key = _hmac(f"AWS4{secret_access_key}".encode("utf-8"), day)
    for part in (region, SERVICE, "aws4_request"):
        signing_key = _hmac(signing_key, part)
    signature = hmac.new(signing_key, to_sign.encode("utf-8"), sha256).hexdigest()

    return f"https://{host}/{path}?{query}&X-Amz-Signature={signature}"
