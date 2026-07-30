"""What the buckets hold, for the screens that decide what to delete.

Reading rather than writing, and D1 rather than R2. Every number here was
recorded when something was verified or completed, so opening a page costs one
query instead of a few hundred billed listings — the sweep in `storage_scan` is
the only thing allowed to ask the buckets directly.

The lists are shaped by the decision they support. Nobody deletes a video
because it is 4 GB; they delete it because the course it belonged to was retired
last year. So a source row carries the lessons that use it, and a version row
carries whether it is the one members are watching.
"""

from shared.common import d1_rows, env_var


GIGABYTE = 1024 * 1024 * 1024

# Configuration rather than constants. R2's prices change, and a number written
# into the program is one nobody will remember to look at — while an estimate
# built from a stale rate looks exactly like an accurate one.
PRICE_VAR = "R2_PRICE_PER_GB_MONTH_USD"
FREE_GB_VAR = "R2_FREE_GB"

# What the overview reads instead of a bucket listing. `verify_encode` already
# counted the bytes while it was checking the objects existed, so the totals are
# a SUM over rows rather than a few hundred billed operations per asset.
# Counted by whether the original actually landed, not by what the asset's status
# says. Archiving a video does not delete its objects and neither does abandoning
# an upload — both are still bytes R2 is charging for, and a total that hides them
# is a total that says the cleanup is done when it is not. Equally, an asset whose
# source upload never completed has a declared size and no object, so counting it
# would invent storage.
SOURCE_TOTALS_SQL = (
    "SELECT COALESCE(SUM(assets.byte_size), 0) AS bytes, COUNT(*) AS objects"
    " FROM video_assets assets"
    " JOIN video_upload_sessions sessions"
    " ON sessions.asset_id = assets.id AND sessions.status = 'completed'"
)
OUTPUT_TOTALS_SQL = (
    "SELECT COALESCE(SUM(byte_size), 0) AS bytes, COALESCE(SUM(object_count), 0) AS objects"
    " FROM video_encode_versions"
)
# Both halves, because both are storage. An asset created last month whose encode
# landed this month grew the bucket this month, and the encodes are usually the
# larger share — growth that counted only originals would report a quiet month
# during the busiest one.
SOURCE_GROWTH_SQL = (
    "SELECT COALESCE(SUM(assets.byte_size), 0) AS bytes"
    " FROM video_assets assets"
    " JOIN video_upload_sessions sessions"
    " ON sessions.asset_id = assets.id AND sessions.status = 'completed'"
    " WHERE sessions.updated_at >= ?1"
)
OUTPUT_GROWTH_SQL = (
    "SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM video_encode_versions WHERE created_at >= ?1"
)


def _bytes_of(rows) -> int:
    return int((rows[0] if rows else {}).get("bytes") or 0)


def _month_start(now: int) -> int:
    """The first second of the month `now` falls in, in UTC.

    Computed here rather than in SQL so there is one idea of where a month
    begins. SQLite's `date('now', 'start of month')` would be a second one, and
    it would disagree in whichever timezone somebody eventually configures.
    """

    from datetime import datetime, timezone

    moment = datetime.fromtimestamp(now, timezone.utc)
    return int(datetime(moment.year, moment.month, 1, tzinfo=timezone.utc).timestamp())


def _pricing(env) -> dict | None:
    """The rate this deployment was told, or nothing.

    Nothing is a real answer. A price that has drifted from R2's is worse than
    an absent one because it reads as a fact, and no code here can tell that it
    has drifted.
    """

    raw = (env_var(env, PRICE_VAR) or "").strip()
    try:
        price = float(raw)
    except ValueError:
        return None
    if price <= 0:
        return None
    try:
        free_gb = float((env_var(env, FREE_GB_VAR) or "0").strip() or 0)
    except ValueError:
        free_gb = 0
    return {"price": price, "free_gb": max(free_gb, 0)}


async def summary(env, *, now: int, orphans: dict | None = None) -> dict:
    """Capacity and what it costs, read from D1 and nothing else.

    `orphans` is handed in rather than looked up. The sweep that produces it
    lives in its own module, and having this one reach for that module while
    that one reaches back for this is a circle held together by both imports
    being deferred to call time.
    """

    source_rows = await d1_rows(env.DB.prepare(SOURCE_TOTALS_SQL))
    output_rows = await d1_rows(env.DB.prepare(OUTPUT_TOTALS_SQL))
    month_start = _month_start(now)
    source_growth = await d1_rows(env.DB.prepare(SOURCE_GROWTH_SQL).bind(month_start))
    output_growth = await d1_rows(env.DB.prepare(OUTPUT_GROWTH_SQL).bind(month_start))

    def totals(rows) -> dict:
        row = rows[0] if rows else {}
        return {"bytes": int(row.get("bytes") or 0), "objects": int(row.get("objects") or 0)}

    source, output = totals(source_rows), totals(output_rows)

    rates = _pricing(env)
    estimate = None
    if rates is not None:
        stored_gb = (source["bytes"] + output["bytes"]) / GIGABYTE
        billable = max(stored_gb - rates["free_gb"], 0)
        estimate = {
            "monthlyUsd": round(billable * rates["price"], 2),
            "pricePerGbMonthUsd": rates["price"],
            "freeGb": rates["free_gb"],
            # The bill also has Class A and Class B operations on it. A number
            # that does not say what it leaves out gets read as the bill.
            "excludesOperations": True,
        }

    return {
        "source": source,
        "output": output,
        # What the last finished sweep found, or nothing at all. Zero would read
        # as "there are none", which is the answer the sweep exists to find out.
        "orphans": orphans,
        "estimate": estimate,
        "growth": {
            "bytesThisMonth": _bytes_of(source_growth) + _bytes_of(output_growth),
        },
    }


# One row per original, with the version totals folded in. A join rather than a
# query per asset: this page is a list, and a query per row is what turns a list
# into a hundred round trips.
SOURCES_SQL = (
    "SELECT assets.id AS id, assets.title AS title, assets.status AS status,"
    " assets.byte_size AS byte_size, assets.active_encode_version AS active_encode_version,"
    " assets.created_at AS created_at,"
    " COUNT(versions.encode_version) AS version_count,"
    " COALESCE(SUM(versions.byte_size), 0) AS version_bytes"
    " FROM video_assets assets"
    " LEFT JOIN video_encode_versions versions ON versions.asset_id = assets.id"
    " GROUP BY assets.id"
    " ORDER BY assets.byte_size DESC LIMIT 200"
)

# Every lesson pointing at any of them, in one query. The course title comes
# along because "3 lessons" is not a reason to keep a file and "水彩入門, which
# closed last year" is.
SOURCE_LESSONS_SQL = (
    "SELECT lessons.video_asset_id AS video_asset_id, lessons.id AS lesson_id,"
    " lessons.title AS lesson_title, courses.id AS course_id, courses.title AS course_title"
    " FROM course_lessons lessons"
    " JOIN course_sections sections ON sections.id = lessons.section_id"
    " JOIN courses ON courses.id = sections.course_id"
    " WHERE lessons.video_asset_id IS NOT NULL"
)

VERSIONS_SQL = (
    "SELECT versions.asset_id AS asset_id, versions.encode_version AS encode_version,"
    " versions.object_count AS object_count, versions.byte_size AS byte_size,"
    " versions.has_poster AS has_poster, versions.verified_at AS verified_at,"
    " assets.active_encode_version AS active_encode_version"
    " FROM video_encode_versions versions"
    " JOIN video_assets assets ON assets.id = versions.asset_id"
    " WHERE versions.asset_id = ?1"
    " ORDER BY versions.encode_version DESC"
)


async def sources(env) -> list[dict]:
    """One row per original file, and what it would cost to keep or lose."""

    rows = await d1_rows(env.DB.prepare(SOURCES_SQL))
    lessons = await d1_rows(env.DB.prepare(SOURCE_LESSONS_SQL))

    used: dict[str, list[dict]] = {}
    for lesson in lessons:
        used.setdefault(lesson["video_asset_id"], []).append(
            {
                "lessonId": lesson["lesson_id"],
                "lessonTitle": lesson["lesson_title"],
                "courseId": lesson["course_id"],
                "courseTitle": lesson["course_title"],
            }
        )

    return [
        {
            "assetId": row["id"],
            "title": row["title"],
            "status": row["status"],
            "bytes": int(row["byte_size"] or 0),
            # Not "is it old". No playable version means the upload never
            # finished, which points the other way about deleting it.
            "hasPlayableVersion": row["active_encode_version"] is not None,
            "activeEncodeVersion": (
                None if row["active_encode_version"] is None else int(row["active_encode_version"])
            ),
            "versionCount": int(row["version_count"] or 0),
            "versionBytes": int(row["version_bytes"] or 0),
            "lessons": used.get(row["id"], []),
            "createdAt": int(row["created_at"] or 0),
        }
        for row in rows
    ]


ALL_VERSIONS_SQL = VERSIONS_SQL.replace(" WHERE versions.asset_id = ?1", "").replace(
    " ORDER BY versions.encode_version DESC", " ORDER BY versions.asset_id, versions.encode_version DESC"
)


def _version_row(row: dict) -> dict:
    return {
        "assetId": row["asset_id"],
        "encodeVersion": int(row["encode_version"]),
        "objectCount": int(row["object_count"] or 0),
        "bytes": int(row["byte_size"] or 0),
        "hasPoster": bool(row["has_poster"]),
        "verifiedAt": int(row["verified_at"] or 0),
        "isActive": row["active_encode_version"] is not None
        and int(row["active_encode_version"]) == int(row["encode_version"]),
        "isSuperseded": row["active_encode_version"] is not None
        and int(row["active_encode_version"]) != int(row["encode_version"]),
    }


async def versions_by_asset(env) -> dict:
    """Every version, grouped by asset, in one query.

    For the cleanup screen, which considers every source in turn. Asking per
    asset is the same N+1 the lessons query already avoided — and this one would
    run it twice over, once for the list and once for the candidates.
    """

    grouped: dict = {}
    for row in await d1_rows(env.DB.prepare(ALL_VERSIONS_SQL)):
        grouped.setdefault(row["asset_id"], []).append(_version_row(row))
    return grouped


async def versions(env, *, asset_id: str) -> list[dict]:
    """One row per encode version of one asset.

    `isActive` and `isSuperseded` are separate answers, not opposites. A version
    of an asset that has none live was never replaced — the upload did not
    finish — and that is a different decision from deleting last year's encode.
    """

    return [_version_row(row) for row in await d1_rows(env.DB.prepare(VERSIONS_SQL).bind(asset_id))]
