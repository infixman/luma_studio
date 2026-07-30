"""Finding the objects nothing points at.

Everything else in this system reads D1, because D1 is cheap and knows what was
supposed to happen. This is the one place that reads the buckets, because the
question is what actually happened — an upload that stopped halfway, a version
that was replaced, an asset somebody abandoned. Those leave objects that no row
mentions, and nothing else will ever notice them.

Listing is billed per object and a course library is tens of thousands, so this
is a deliberate action with a written-down result rather than something a page
does when it opens.

Two rules keep it from deleting a video somebody is uploading:

An asset that is still `uploading` is skipped entirely. Its objects look exactly
like an abandoned upload's, because the row that will claim them is written when
the upload finishes.

An object younger than a day is skipped whatever it belongs to. The scan cannot
see a transfer that is in flight, so it refuses to have an opinion about one.
The cost of missing an orphan is that it is found next time; the cost of the
other mistake is a member's video disappearing mid-lesson.
"""

import re

from domain import video
from shared.common import d1_rows, urlsafe_token, utc_timestamp


# Nothing younger than this is judged. A multi-gigabyte source upload can take
# most of a day, and a scan that ran during one would see parts belonging to a
# session whose row is not written yet.
MIN_AGE_SECONDS = 24 * 60 * 60

# The two shapes anything writes. The asset id part is taken from `video`, not
# spelled again — that module's own comment says the shape is validated in one
# place rather than five that could disagree, and a copy here would disagree by
# reporting real objects as rubbish the day the id charset changes.
_ASSET = video.ASSET_ID_PATTERN.pattern.strip("^$")
OUTPUT_KEY = re.compile(rf"^videos/(?P<asset>{_ASSET})/(?P<version>\d{{1,3}})/.+$")
SOURCE_KEY = re.compile(rf"^sources/(?P<asset>{_ASSET})/(?P<version>\d{{1,3}})/.+$")

BUCKETS = ("source", "output")


def classify(key: str, *, kind: str) -> dict | None:
    """Which asset and version an object belongs to, if its name says.

    A key that does not match is not an error and not automatically rubbish: it
    is something this system did not write, and the honest thing is to report it
    as an orphan rather than to skip it silently or delete it confidently.
    """

    pattern = SOURCE_KEY if kind == "source" else OUTPUT_KEY
    found = pattern.match(key or "")
    if not found:
        return None
    return {"assetId": found.group("asset"), "version": int(found.group("version"))}


def is_orphan(entry: dict, *, kind: str, claimed: set, uploading: set, now: int) -> bool:
    """Whether nothing in D1 accounts for this object.

    `claimed` is the set of `(assetId, version)` pairs D1 says exist — encode
    versions for the output bucket, completed source uploads for the other.
    `uploading` is the assets whose upload has not finished, which are skipped
    whatever their objects look like.
    """

    if int(entry.get("uploadedAt") or 0) > now - MIN_AGE_SECONDS:
        return False

    belongs = classify(entry["key"], kind=kind)
    if belongs is None:
        # Not a shape this system writes. Reported, because the alternative is a
        # bucket accumulating things nobody can see.
        return True
    if belongs["assetId"] in uploading:
        return False
    return (belongs["assetId"], belongs["version"]) not in claimed


async def claimed_versions(env) -> set:
    """Every `(assetId, encodeVersion)` an encode version row accounts for.

    Retired assets are deliberately absent: archiving or abandoning one does not
    delete its objects, and those objects are exactly what a cleanup is for. The
    scan reports them; deleting them stays a decision somebody makes.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT versions.asset_id AS asset_id, versions.encode_version AS encode_version"
            " FROM video_encode_versions versions"
            " JOIN video_assets assets ON assets.id = versions.asset_id"
            " WHERE assets.status NOT IN ('aborted', 'archived')"
        )
    )
    return {(row["asset_id"], int(row["encode_version"])) for row in rows}


async def claimed_sources(env) -> set:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT assets.id AS asset_id FROM video_assets assets"
            " JOIN video_upload_sessions sessions"
            " ON sessions.asset_id = assets.id AND sessions.status = 'completed'"
            " WHERE assets.status NOT IN ('aborted', 'archived')"
        )
    )
    # Sources have one version, and the key builder writes it as 1.
    return {(row["asset_id"], 1) for row in rows}


async def uploading_assets(env) -> set:
    rows = await d1_rows(
        env.DB.prepare("SELECT id FROM video_assets WHERE status = 'uploading'")
    )
    return {row["id"] for row in rows}


# One page at a time, and a ceiling on how many pages. A sweep that ran until it
# finished would be a request that never returns on a library large enough to
# need one — so it stops, records that it stopped early, and the page says so.
PAGE = 1000
MAX_PAGES = 20

# How many orphans one sweep writes down. There is no batch insert available from
# this runtime (see the note in `domain/shop.py`), so every orphan is its own
# statement — and a bucket with fifty thousand of them would be fifty thousand
# awaited writes in one request, which does not finish. A sweep that hits this
# says so, and the next one picks up what it did not reach.
MAX_RECORDED = 500

# A sweep that started and never finished blocks another one for this long. Long
# enough that two admins pressing the button do not double the bill; short enough
# that an isolate dying mid-sweep does not lock the feature out for a day.
SWEEP_LOCK_SECONDS = 30 * 60

RECORD_ORPHAN_SQL = (
    "INSERT INTO video_storage_orphans (scan_id, bucket, object_key, byte_size, uploaded_at)"
    " VALUES (?1, ?2, ?3, ?4, ?5)"
    " ON CONFLICT(scan_id, bucket, object_key) DO UPDATE SET"
    " byte_size = excluded.byte_size, uploaded_at = excluded.uploaded_at"
)

FINISH_SCAN_SQL = (
    "UPDATE video_storage_scans SET finished_at = ?2, source_orphan_bytes = ?3,"
    " source_orphan_objects = ?4, output_orphan_bytes = ?5, output_orphan_objects = ?6,"
    " truncated = ?7, updated_at = ?2 WHERE id = ?1"
)


async def run_scan(env, *, now: int | None = None) -> dict:
    """Sweep both buckets and write down what nothing accounts for.

    The scan row is written first and finished last. A sweep that dies halfway
    leaves a row with no `finished_at`, which is a fact worth having: the
    overview can say the last one did not complete instead of showing yesterday's
    numbers as if they were today's.
    """

    from domain import video_storage

    now = utc_timestamp() if now is None else now

    # Both bindings first. Writing the scan row and then discovering the second
    # bucket is not configured leaves a row nothing can finish and orphan rows
    # nothing can read.
    buckets = {kind: video_storage.binding_for(env, kind) for kind in BUCKETS}

    running = await d1_rows(
        env.DB.prepare(
            "SELECT id FROM video_storage_scans WHERE finished_at IS NULL AND started_at > ?1"
        ).bind(now - SWEEP_LOCK_SECONDS)
    )
    if running:
        # Two sweeps are two full listings of both buckets, which is the exact
        # cost this design exists to spend once.
        raise ValueError("已經有一次盤點在進行中，請稍後再試")

    scan_id = urlsafe_token(12)
    await env.DB.prepare(
        "INSERT INTO video_storage_scans (id, started_at, finished_at, created_at, updated_at)"
        " VALUES (?1, ?2, NULL, ?2, ?2)"
    ).bind(scan_id, now).run()

    uploading = await uploading_assets(env)
    claims = {"source": await claimed_sources(env), "output": await claimed_versions(env)}
    totals = {"source": {"bytes": 0, "objects": 0}, "output": {"bytes": 0, "objects": 0}}
    truncated = False

    recorded = 0
    for kind in BUCKETS:
        bucket = buckets[kind]
        prefix = "sources/" if kind == "source" else "videos/"
        cursor = None
        for _ in range(MAX_PAGES):
            listing = await bucket.list(prefix=prefix, limit=PAGE, cursor=cursor)
            for item in listing.objects:
                entry = {
                    "key": item.key,
                    "size": int(item.size),
                    "uploadedAt": video_storage.uploaded_seconds(item),
                }
                if not is_orphan(entry, kind=kind, claimed=claims[kind], uploading=uploading, now=now):
                    continue
                totals[kind]["bytes"] += entry["size"]
                totals[kind]["objects"] += 1
                if recorded >= MAX_RECORDED:
                    # Counted but not listed. The totals still say how much is
                    # wasted; the list somebody acts on is bounded.
                    truncated = True
                    continue
                recorded += 1
                await env.DB.prepare(RECORD_ORPHAN_SQL).bind(
                    scan_id, kind, entry["key"], entry["size"], entry["uploadedAt"]
                ).run()
            if not listing.truncated:
                break
            cursor = getattr(listing, "cursor", None)
            if not cursor:
                # Truncated with nowhere to continue from. Asking again with no
                # cursor re-reads page one, which double-counts everything on it.
                truncated = True
                break
        else:
            # Stopped at the page limit with more to read. Recorded rather than
            # hidden: a partial sweep that looks complete is how a cleanup screen
            # tells somebody there is nothing left when there is.
            truncated = True

    await env.DB.prepare(FINISH_SCAN_SQL).bind(
        scan_id,
        now,
        totals["source"]["bytes"],
        totals["source"]["objects"],
        totals["output"]["bytes"],
        totals["output"]["objects"],
        1 if truncated else 0,
    ).run()

    return {
        "scanId": scan_id,
        "scannedAt": now,
        "truncated": truncated,
        "source": totals["source"],
        "output": totals["output"],
    }


async def latest_scan(env) -> dict | None:
    """The last sweep that finished, or nothing.

    Unfinished sweeps are not reported as results. A row with no `finished_at`
    is a sweep that died, and its counts are whatever it had reached — which is
    not an answer to "how much is wasted".
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM video_storage_scans WHERE finished_at IS NOT NULL"
            " ORDER BY finished_at DESC LIMIT 1"
        )
    )
    if not rows:
        return None
    row = rows[0]
    return {
        "scanId": row["id"],
        "scannedAt": int(row["finished_at"]),
        "truncated": bool(row["truncated"]),
        "sourceBytes": int(row["source_orphan_bytes"]),
        "sourceObjects": int(row["source_orphan_objects"]),
        "outputBytes": int(row["output_orphan_bytes"]),
        "outputObjects": int(row["output_orphan_objects"]),
    }


async def orphans(env, *, bucket: str, limit: int = 200) -> list[dict]:
    """What the last finished sweep found in one bucket."""

    if bucket not in BUCKETS:
        raise ValueError("bucket 必須是 source 或 output")
    scan = await latest_scan(env)
    if scan is None:
        return []
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT object_key, byte_size, uploaded_at FROM video_storage_orphans"
            " WHERE scan_id = ?1 AND bucket = ?2 ORDER BY byte_size DESC LIMIT ?3"
        ).bind(scan["scanId"], bucket, limit)
    )
    return [
        {
            "key": row["object_key"],
            "size": int(row["byte_size"]),
            "uploadedAt": None if row["uploaded_at"] is None else int(row["uploaded_at"]),
        }
        for row in rows
    ]
