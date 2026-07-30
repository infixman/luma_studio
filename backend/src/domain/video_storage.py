"""Handing out permission to write one object to R2.

The desktop tool holds no R2 credential — an installer on the internet is not a
place to keep a long-lived key — so every byte it writes goes through a URL
granted here. That makes this module the whole of what the tool can do to the
buckets, and the interesting part of it is the refusals.

Three things are decided, in this order, and none of them is optional:

The asset has to be one that is still being uploaded. A `ready` asset's objects
are what members are watching, and a write URL for one of those would let a
stray retry overwrite a live encode.

Every key has to belong to this asset and this version. `video.signable_key`
answers that, so nothing here parses a key.

The batch has to be small. One request must not become thousands of live
credentials, because a presigned URL is a bearer token and there is no way to
recall one.

Nothing in here is logged. A signed URL in a log is a signed URL somebody can
use, and the log outlives the fifteen minutes.

It has since grown two things that are not signing: a read-only listing, and the
storage totals the overview reads. They are here because they are about the same
two buckets and the same configuration; if a third arrives, this file wants
splitting into "what may be written" and "what is there".
"""

from domain import video
from shared import sigv4
from shared.common import NotConfigured, d1_rows, env_var, utc_timestamp


# Long enough for the tool to work through a batch on a slow connection, short
# enough that a leaked URL is not much of a leak. The tool asks in batches for
# this reason rather than requesting a whole ladder up front.
URL_TTL = 15 * 60

# One request, at most this many credentials. A ladder for a long lesson is
# hundreds of objects, so the tool asks repeatedly; that is the intended shape.
MAX_URLS = 100

# Which bucket each kind of object lives in. The binding gives the Worker an
# object it can read and write, but not the bucket's name, and a presigned URL
# needs the name — so it comes from configuration.
BUCKET_VARS = {"source": "COURSE_SOURCE_BUCKET", "output": "COURSE_VIDEO_BUCKET"}


def credentials_for(env) -> dict:
    """The three values a signed request needs, or a refusal that says so.

    Public because the source-file upload signs its own requests through
    `shared.r2_s3` — same credentials, same refusal when they are absent.
    """

    endpoint = env_var(env, "R2_S3_ENDPOINT")
    access_key_id = env_var(env, "R2_ACCESS_KEY_ID")
    secret_access_key = env_var(env, "R2_SECRET_ACCESS_KEY")
    if not endpoint or not access_key_id or not secret_access_key:
        raise NotConfigured("R2 signing is not configured")
    return {
        "endpoint": endpoint,
        "access_key_id": access_key_id,
        "secret_access_key": secret_access_key,
    }


def bucket_for(env, kind: str) -> str:
    if kind not in BUCKET_VARS:
        raise ValueError(f"Unknown object kind: {kind}")
    name = env_var(env, BUCKET_VARS[kind])
    if not name:
        raise NotConfigured(f"{BUCKET_VARS[kind]} is not configured")
    return name


# One page of a browse, and the reason there is a limit at all: listing is the
# only operation here that is billed per object rather than per request.
MAX_LISTED = 200

# What a caller may look under. Not a prefix of their choosing: `list` with an
# empty prefix walks the whole bucket, and the two prefixes below are the only
# shapes anything writes.
LIST_PREFIXES = ("sources/", "videos/")


def validate_prefix(prefix) -> str:
    """The folder to look in, or a refusal.

    A browse is read-only and returns no signed URLs, so the risk is not what it
    lets somebody take — it is the operation count, and a caller naming `""`
    listing a bucket of a hundred thousand objects one page at a time.
    """

    prefix = str(prefix or "").strip()
    if not prefix.startswith(LIST_PREFIXES):
        raise ValueError("只能瀏覽 sources/ 或 videos/ 底下的內容")
    if ".." in prefix.split("/") or prefix.startswith("/"):
        raise ValueError("路徑格式不正確")
    return prefix


async def list_objects(env, *, kind: str, prefix: str, cursor: str | None = None) -> dict:
    """What is actually in the bucket under this prefix.

    Keys, sizes and times — no signed URLs. This exists so somebody can confirm
    an upload arrived, and confirming does not require the ability to read the
    bytes back. Handing out a URL here would also be a second entrance to objects
    the playback gateway is the entrance to.
    """

    bucket = binding_for(env, kind)
    listing = await bucket.list(prefix=validate_prefix(prefix), limit=MAX_LISTED, cursor=cursor)
    return {
        "objects": [
            {
                "key": item.key,
                "size": int(item.size),
                # R2 gives a Date; the rest of this API speaks epoch seconds.
                "uploadedAt": uploaded_seconds(item) or None,
            }
            for item in listing.objects
        ],
        "truncated": bool(listing.truncated),
        "cursor": getattr(listing, "cursor", None) if listing.truncated else None,
    }


def uploaded_seconds(item) -> int:
    """When R2 says this object landed, in the seconds the rest of this speaks.

    Zero when it will not say. Used by the orphan scan as an age, where "unknown"
    must not read as "brand new" — an object nobody can date is one the scan is
    allowed to judge.
    """

    uploaded = getattr(item, "uploaded", None)
    if uploaded is None:
        return 0
    try:
        return int(uploaded.getTime() // 1000)
    except (AttributeError, TypeError, ValueError):
        return 0


def binding_for(env, kind: str):
    """The R2 binding for this kind of object.

    Separate from `bucket_for`, which answers with the bucket's *name* for a
    signature. Both exist because the binding does not know its own name.
    """

    if kind not in BUCKET_VARS:
        raise ValueError(f"Unknown object kind: {kind}")
    binding = getattr(env, "COURSE_SOURCE" if kind == "source" else "COURSE_VIDEO", None)
    if binding is None:
        raise NotConfigured("影片儲存空間尚未綁定")
    return binding


def upload_urls(env, *, asset: dict, keys, kind: str, version: int, now: int | None = None) -> list[dict]:
    """One short-lived PUT URL per key, or nothing at all.

    Validated as a batch on purpose. Signing the acceptable keys and quietly
    dropping the rest would leave the tool believing it had URLs for everything
    it asked about, and it would find out at the end of a long upload — the
    most expensive moment.
    """

    if asset["status"] != "uploading":
        raise ValueError("這支影片已經不在上傳中")
    if not isinstance(keys, list) or not keys:
        raise ValueError("沒有要上傳的檔案")
    if len(keys) > MAX_URLS:
        raise ValueError(f"一次最多 {MAX_URLS} 個檔案")

    bucket = bucket_for(env, kind)
    credentials = credentials_for(env)
    checked = [
        video.signable_key(key, asset_id=asset["id"], version=version, kind=kind) for key in keys
    ]

    now = utc_timestamp() if now is None else now
    return [
        {
            "key": key,
            "url": sigv4.presigned_url(
                method="PUT", bucket=bucket, key=key, now=now, expires=URL_TTL, **credentials
            ),
            "expiresAt": now + URL_TTL,
        }
        for key in checked
    ]
