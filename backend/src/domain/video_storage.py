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
"""

from domain import video
from shared import sigv4
from shared.common import NotConfigured, env_var, utc_timestamp


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
