"""The three multipart calls the Worker makes itself.

The desktop tool uploads the parts — those are the bytes, and they must not pass
through here. Everything else about a multipart upload is bookkeeping the server
has to be part of: `create` is where R2 issues the upload id, and `complete` and
`abort` end the upload, which the spec requires to be idempotent — a property of
a route with a session row behind it rather than of a URL. So the Worker signs
those three for itself and sends them.

Three behaviours of the S3 API shape this module, and all three fail quietly:

`CompleteMultipartUpload` answers **200 with an error inside the body**. The
connection is held open while R2 assembles the parts, so the status line is
written before the outcome is known. Checking `response.ok` and moving on
records a finished upload that does not exist.

Aborting an upload that is already gone answers 404 `NoSuchUpload`, and that is
success — the retry is the ordinary path, and the second attempt finds nothing
precisely because the first one worked. A 404 that says something *else* is a
misconfiguration wearing the same status code, and calling that "cancelled"
hides it until somebody reads the storage bill.

**Completing twice is not distinguishable from completing something that never
existed.** A finished upload's id stops existing, so both answer `NoSuchUpload`.
That matters in exactly one case: R2 assembled the object and the answer was
lost. This module cannot tell those apart, so it does not try — `R2Error` carries
the code, and the route layer, which has a session row and can look at the
object, decides.

Nothing here is logged, and no error carries the URL: a signed URL is a bearer
credential with minutes left on it, and an error string is the one place nobody
reads carefully.
"""

import re

from js import fetch as js_fetch

from shared import sigv4
from shared.common import js_options


# The Worker sends these itself and waits for the answer, so the window only has
# to cover one request rather than a batch somebody holds. The caller must take
# `now` immediately before the call: a timestamp read at the top of a handler and
# used after some D1 work can be older than this, and the failure is a 403 that
# looks like a signing bug.
REQUEST_TTL = 60

# What an ETag may contain. Deliberately a character set rather than "32 hex
# digits, optionally quoted, optionally with a part count": that is what R2
# returns today, and pinning it would turn any future change on their side into
# an upload this code refuses for a reason nobody could act on.
#
# The property that actually matters is that none of these characters can end
# the element and start another one — the tags arrive back through the desktop
# tool, so they are not ours.
ETAG_PATTERN = re.compile(r'^"?[A-Za-z0-9+/=._-]{1,128}"?$')

# The three fields a signed request needs. Checked rather than indexed blindly,
# so a caller that assembled the dict wrongly gets an error naming the problem
# instead of a KeyError from inside the signer.
CREDENTIAL_FIELDS = ("endpoint", "access_key_id", "secret_access_key")

# Codes that mean "the upload you asked about is not there". For an abort that is
# the desired state; for a complete it is the ambiguous answer above.
GONE_CODES = ("NoSuchUpload", "NoSuchKey")

_ENTITIES = {"&quot;": '"', "&lt;": "<", "&gt;": ">", "&amp;": "&", "&apos;": "'"}


class R2Error(Exception):
    """R2 refused, or answered something this code will not act on.

    Carries the status and the S3 error code as values. The route layer has to
    tell `NoSuchUpload` from the rest, and reading it back out of a sentence is
    not a way to do that.
    """

    def __init__(self, message: str, *, status: int = 0, code: str = ""):
        super().__init__(message)
        self.status = status
        self.code = code


# S3 replies are small, fixed-shape documents from a service, not user content —
# so one element is pulled out by pattern rather than by building a parser. The
# values that come *in* are checked separately, below.
def _element(xml: str, tag: str) -> str:
    found = re.search(rf"<{tag}>(.*?)</{tag}>", xml or "", re.DOTALL)
    return found.group(1).strip() if found else ""


def _error_code(xml: str) -> str:
    return _element(xml, "Code")


def _unescape(value: str) -> str:
    """One pass, so `&amp;lt;` comes back as `&lt;` rather than as `<`.

    Replacing entity by entity decodes its own output: `&amp;` becomes `&`, and
    the `&lt;` that was never in the original then gets decoded too.
    """

    return re.sub(r"&(?:quot|apos|lt|gt|amp);", lambda found: _ENTITIES[found.group(0)], value or "")


async def _send(url: str, *, method: str, body=None, content_type=None) -> tuple[int, str]:
    """One HTTP request, and the one place `fetch` is called.

    Separated so tests can drive the module without a network, the same way
    `mail._post` is — and, like it, everything the runtime can throw is turned
    into this module's own error. A caller distinguishing "R2 said no" from "the
    connection broke" has to be able to catch one type.
    """

    options = {"method": method}
    if body is not None:
        options["body"] = body
        options["headers"] = {"content-type": content_type or "application/xml"}
    try:
        response = await js_fetch(url, js_options(options))
        return int(response.status), str(await response.text())
    except Exception as error:  # network, DNS, timeout, a body that will not read
        # The message is the runtime's, so it is bounded and the URL is not in
        # it — that URL is a live credential.
        raise R2Error(f"R2 could not be reached: {str(error)[:200]}") from error


def _url(operation: str, *, credentials: dict, bucket: str, key: str, now: int, **extra) -> str:
    missing = [field for field in CREDENTIAL_FIELDS if not (credentials or {}).get(field)]
    if missing:
        raise R2Error(f"R2 signing is not configured: missing {', '.join(missing)}")
    return sigv4.presigned_multipart_url(
        operation=operation,
        endpoint=credentials["endpoint"],
        bucket=bucket,
        key=key,
        access_key_id=credentials["access_key_id"],
        secret_access_key=credentials["secret_access_key"],
        now=now,
        expires=REQUEST_TTL,
        **extra,
    )


def _refuse(what: str, status: int, body: str) -> R2Error:
    code = _error_code(body)
    return R2Error(f"R2 refused to {what}: {status} {code or 'unknown'}", status=status, code=code)


async def start_multipart(*, credentials: dict, bucket: str, key: str, now: int) -> str:
    """Ask R2 to open a multipart upload, and return the id it issued."""

    status, body = await _send(
        _url("create", credentials=credentials, bucket=bucket, key=key, now=now), method="POST"
    )
    if status < 200 or status >= 300:
        raise _refuse("start the upload", status, body)
    # The same trap as `complete`: an error can arrive under a 200. It would fail
    # below anyway for want of an id, but "R2 started an upload without saying
    # which one" tells an operator nothing and `AccessDenied` tells them
    # everything.
    if "<Error" in body:
        raise _refuse("start the upload", status, body)

    upload_id = _unescape(_element(body, "UploadId"))
    if not upload_id:
        # An empty id would be signed into part URLs that mean nothing, and the
        # upload would fail several hundred parts later.
        raise R2Error("R2 started an upload without saying which one", status=status)
    return upload_id


def _parts_xml(parts) -> str:
    """The document naming what the finished object is made of.

    Sorted by part number because S3 requires ascending order and the caller
    collected these as they finished, which is not the same thing.

    The tags come back through the desktop tool, so they are checked rather than
    escaped: an ETag is a short opaque token, and anything else in one is either
    a bug or an attempt to write the rest of this document.
    """

    if not parts:
        raise ValueError("A completed upload needs at least one part")

    seen: set[int] = set()
    rows = []
    for number, etag in parts:
        if (
            isinstance(number, bool)
            or not isinstance(number, int)
            or number < 1
            or number > sigv4.MAX_PART_NUMBER
        ):
            raise ValueError(f"Part number must be between 1 and {sigv4.MAX_PART_NUMBER}")
        if number in seen:
            raise ValueError(f"Part {number} was given twice")
        seen.add(number)
        if not isinstance(etag, str) or not etag.strip():
            raise ValueError(f"Part {number} has no ETag")
        if not ETAG_PATTERN.fullmatch(etag.strip()):
            raise ValueError(f"Part {number} has an ETag this will not send")
        rows.append((number, etag.strip()))

    rows.sort()
    inner = "".join(
        f"<Part><PartNumber>{number}</PartNumber><ETag>{etag}</ETag></Part>" for number, etag in rows
    )
    return f"<CompleteMultipartUpload>{inner}</CompleteMultipartUpload>"


async def complete_multipart(
    *, credentials: dict, bucket: str, key: str, upload_id: str, parts, now: int
) -> str:
    """Assemble the parts into the object, and return its ETag.

    A failure carries `code`, and the one the caller must handle rather than
    report is `NoSuchUpload`: it means either this upload was completed already —
    possibly by the request whose answer was lost — or it never existed.
    """

    body = _parts_xml(parts)
    status, answer = await _send(
        _url("complete", credentials=credentials, bucket=bucket, key=key, now=now, upload_id=upload_id),
        method="POST",
        body=body,
    )
    if status < 200 or status >= 300:
        raise _refuse("finish the upload", status, answer)

    # The trap this module exists to remember.
    if "<Error" in answer:
        raise _refuse("finish the upload", status, answer)

    return _unescape(_element(answer, "ETag"))


async def abort_multipart(*, credentials: dict, bucket: str, key: str, upload_id: str, now: int) -> None:
    """Cancel a pending upload. Doing it twice is not an error."""

    status, answer = await _send(
        _url("abort", credentials=credentials, bucket=bucket, key=key, now=now, upload_id=upload_id),
        method="DELETE",
    )
    if 200 <= status < 300:
        return

    code = _error_code(answer)
    # Already gone is the state that was asked for. A 404 that says something
    # else — no such bucket, most likely — is a misconfiguration, and answering
    # "cancelled" to it hides the fault while the uploads pile up.
    if status == 404 and (code in GONE_CODES or not code):
        return
    raise _refuse("cancel the upload", status, answer)
