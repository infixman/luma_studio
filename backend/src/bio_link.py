"""The site's single bio link page: its settings, buttons and visit records.

Events are written but nothing reads them yet; the reporting UI is a later
phase. They are recorded from the start so that phase has history to show.
"""

import hashlib
import re
from urllib.parse import urlsplit, urlunsplit

from common import d1_rows, env_var, secure_bytes, taipei_day, urlsafe_token, utc_timestamp


ITEM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,60}$")

ALLOWED_URL_SCHEMES = frozenset({"http", "https", "mailto", "tel"})
MAX_URL_LENGTH = 2048
MAX_DISPLAY_NAME = 64
MAX_BIO = 300
MAX_TITLE = 80
MAX_ITEMS = 50

ITEM_KINDS = frozenset({"link", "social"})
SOCIAL_PLATFORMS = frozenset(
    {"instagram", "facebook", "threads", "youtube", "x", "tiktok", "line", "pixnet", "email", "website"}
)

AVATAR_PREFIX = "_bio-link"
AVATAR_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
AVATAR_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}
MAX_AVATAR_BYTES = 2 * 1024 * 1024

# Link unfurlers are the traffic a share link attracts most, and each one can
# fetch several times per share. Counting them as visitors would inflate the
# numbers precisely on the channels this page exists to serve.
BOT_MARKERS = (
    "bot",
    "crawler",
    "spider",
    "slurp",
    "curl",
    "wget",
    "python-requests",
    "headless",
    "facebookexternalhit",
    "whatsapp",
    "telegram",
    "discord",
    "linkedin",
    "embedly",
    "pinterest",
    "skypeuripreview",
    "quora link preview",
)

# Without a configured salt, a per-isolate random value keeps visitor hashes
# unlinkable to an IP. Dedupe then only works within one isolate, which is a
# fair trade against shipping a known salt in the source.
#
# Generated on first use, never at import: the Workers runtime forbids
# random generation (and any I/O) in global scope, and a module-level call
# stops the whole Worker from loading.
_fallback_salt: str | None = None


def _visitor_salt(env) -> str:
    global _fallback_salt
    configured = env_var(env, "VISITOR_SALT")
    if configured:
        return configured
    if _fallback_salt is None:
        _fallback_salt = secure_bytes(32).hex()
    return _fallback_salt


def validate_item_id(item_id: str) -> str:
    if not ITEM_ID_PATTERN.fullmatch(item_id):
        raise ValueError("Invalid link id")
    return item_id


def validate_url(url: str) -> str:
    """Return a URL that is safe to put in a Location header.

    `urlsplit` silently strips tabs and newlines before parsing, so validating
    the input and storing the original would let `https://a/\\r\\nHeader: x`
    through. Reject control characters outright and return the re-serialised
    form, so what was checked is exactly what gets stored.
    """

    url = url.strip()
    if not url or len(url) > MAX_URL_LENGTH:
        raise ValueError(f"A link URL must be 1-{MAX_URL_LENGTH} characters")
    if any(character < " " or character == "\x7f" for character in url):
        raise ValueError("A link URL must not contain control characters")
    parts = urlsplit(url)
    # An allowlist, not a javascript: denylist: data:, blob: and vbscript: run
    # in the visitor's browser just as happily.
    if parts.scheme.lower() not in ALLOWED_URL_SCHEMES:
        raise ValueError("A link URL must start with http, https, mailto or tel")
    if parts.scheme.lower() in {"http", "https"} and not parts.netloc:
        raise ValueError("A web link must include a host")
    return urlunsplit(parts)


def validate_text(value: str, limit: int, label: str, required: bool = True) -> str:
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required")
    if len(value) > limit:
        raise ValueError(f"{label} must be {limit} characters or fewer")
    return value


def validate_kind(kind: str) -> str:
    if kind not in ITEM_KINDS:
        raise ValueError("A link must be of kind 'link' or 'social'")
    return kind


def validate_platform(kind: str, platform) -> str | None:
    if kind != "social":
        return None
    if platform not in SOCIAL_PLATFORMS:
        raise ValueError("Unsupported social platform")
    return str(platform)


def avatar_key(suffix: str) -> str:
    # The underscore prefix keeps this out of IDENTIFIER_PATTERN, so avatars
    # never appear as ibon folders and /images/ cannot reach them.
    return f"{AVATAR_PREFIX}/{urlsafe_token(12)}{suffix}"


AVATAR_URL_PREFIX = "/bio-link-assets"


def avatar_path(key: str | None) -> str | None:
    """The public URL path for a stored avatar key.

    The R2 prefix and the URL differ, so the mapping lives here instead of
    being reconstructed by every caller.
    """

    if not key or not key.startswith(f"{AVATAR_PREFIX}/"):
        return None
    return f"{AVATAR_URL_PREFIX}/{key.removeprefix(AVATAR_PREFIX + '/')}"


def item_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "url": row["url"],
        "platform": row["platform"],
        "position": row["position"],
        "enabled": bool(row["enabled"]),
    }


async def get_settings(env) -> dict:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM bio_link_settings WHERE id = 1"))
    if not rows:
        return {"displayName": "", "bio": "", "avatarKey": None, "avatarPath": None}
    row = rows[0]
    return {
        "displayName": row["display_name"],
        "bio": row["bio"],
        "avatarKey": row["avatar_key"],
        "avatarPath": avatar_path(row["avatar_key"]),
    }


async def save_settings(env, display_name: str, bio: str):
    await env.DB.prepare(
        "INSERT INTO bio_link_settings (id, display_name, bio, updated_at) VALUES (1, ?1, ?2, ?3)"
        " ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio,"
        " updated_at = excluded.updated_at"
    ).bind(display_name, bio, utc_timestamp()).run()


async def set_avatar_key(env, key: str | None):
    await env.DB.prepare(
        "INSERT INTO bio_link_settings (id, avatar_key, updated_at) VALUES (1, ?1, ?2)"
        " ON CONFLICT(id) DO UPDATE SET avatar_key = excluded.avatar_key, updated_at = excluded.updated_at"
    ).bind(key, utc_timestamp()).run()


async def list_items(env, only_enabled: bool = False) -> list[dict]:
    query = "SELECT * FROM bio_link_items"
    if only_enabled:
        query += " WHERE enabled = 1"
    query += " ORDER BY position, created_at, id"
    return [item_row(row) for row in await d1_rows(env.DB.prepare(query))]


async def get_item(env, item_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM bio_link_items WHERE id = ?1").bind(item_id))
    return item_row(rows[0]) if rows else None


async def count_items(env) -> int:
    rows = await d1_rows(env.DB.prepare("SELECT COUNT(*) AS total FROM bio_link_items"))
    return int(rows[0]["total"]) if rows else 0


async def create_item(env, kind: str, title: str, url: str, platform: str | None) -> str:
    rows = await d1_rows(
        env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM bio_link_items WHERE kind = ?1").bind(kind)
    )
    position = (int(rows[0]["last"]) if rows else -1) + 1
    item_id, now = urlsafe_token(18), utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO bio_link_items (id, kind, title, url, platform, position, enabled, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)"
    ).bind(item_id, kind, title, url, platform, position, now).run()
    return item_id


async def update_item(env, item_id: str, title: str, url: str, enabled: bool) -> bool:
    """Returns False when no such link exists, so callers can answer 404."""

    if await get_item(env, item_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE bio_link_items SET title = ?2, url = ?3, enabled = ?4, updated_at = ?5 WHERE id = ?1"
    ).bind(item_id, title, url, 1 if enabled else 0, utc_timestamp()).run()
    return True


async def delete_item(env, item_id: str) -> bool:
    if await get_item(env, item_id) is None:
        return False
    await env.DB.prepare("DELETE FROM bio_link_items WHERE id = ?1").bind(item_id).run()
    await env.DB.prepare("DELETE FROM bio_link_events WHERE item_id = ?1").bind(item_id).run()
    return True


async def reorder_items(env, ordered_ids: list[str]):
    """Rewrite positions from a full ordering supplied by the client.

    The editor always holds the complete list, so overwriting every position
    avoids the half-applied states that move-one-step operations produce. The
    list is deduplicated and capped, because it arrives from the network and a
    statement per id is only acceptable while the count is bounded.
    """

    seen: list[str] = []
    for item_id in ordered_ids:
        if item_id not in seen:
            seen.append(item_id)
    if len(seen) > MAX_ITEMS:
        raise ValueError(f"At most {MAX_ITEMS} links can be ordered at once")

    now = utc_timestamp()
    for position, item_id in enumerate(seen):
        await env.DB.prepare("UPDATE bio_link_items SET position = ?2, updated_at = ?3 WHERE id = ?1").bind(
            item_id, position, now
        ).run()


MAX_STATS_DAYS = 90
DEFAULT_STATS_DAYS = 30


def _window_start(days: int) -> str:
    from datetime import datetime, timedelta, timezone

    taipei_now = datetime.now(timezone.utc) + timedelta(hours=8)
    return (taipei_now - timedelta(days=days - 1)).strftime("%Y-%m-%d")


async def _grouped(env, column: str, since: str, limit: int = 6) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare(
            f"SELECT {column} AS label, COUNT(*) AS total FROM bio_link_events"
            f" WHERE day >= ?1 AND {column} IS NOT NULL AND {column} != ''"
            f" GROUP BY {column} ORDER BY total DESC LIMIT ?2"
        ).bind(since, limit)
    )
    return [{"label": row["label"], "total": int(row["total"])} for row in rows]


async def get_stats(env, days: int) -> dict:
    """Counts over the last `days` Taipei days.

    Every figure is distinct visitors, not raw hits: `record_event` keeps one
    row per visitor, per day, per target, so a refresh cannot inflate them.
    """

    days = max(1, min(days, MAX_STATS_DAYS))
    since = _window_start(days)

    daily_rows = await d1_rows(
        env.DB.prepare(
            "SELECT day, event_type, COUNT(*) AS total FROM bio_link_events"
            " WHERE day >= ?1 GROUP BY day, event_type ORDER BY day"
        ).bind(since)
    )
    daily: dict[str, dict[str, int]] = {}
    for row in daily_rows:
        entry = daily.setdefault(row["day"], {"day": row["day"], "views": 0, "clicks": 0})
        entry["views" if row["event_type"] == "view" else "clicks"] = int(row["total"])

    item_rows = await d1_rows(
        env.DB.prepare(
            "SELECT e.item_id AS id, COALESCE(i.title, '（已刪除）') AS title, COUNT(*) AS total"
            " FROM bio_link_events e LEFT JOIN bio_link_items i ON i.id = e.item_id"
            " WHERE e.day >= ?1 AND e.event_type = 'click' AND e.item_id IS NOT NULL"
            " GROUP BY e.item_id, i.title ORDER BY total DESC"
        ).bind(since)
    )

    return {
        "days": days,
        "since": since,
        "views": sum(entry["views"] for entry in daily.values()),
        "clicks": sum(entry["clicks"] for entry in daily.values()),
        "daily": sorted(daily.values(), key=lambda entry: entry["day"]),
        "items": [{"id": row["id"], "title": row["title"], "total": int(row["total"])} for row in item_rows],
        "countries": await _grouped(env, "country", since),
        "referrers": await _grouped(env, "referrer_host", since),
        "devices": await _grouped(env, "device", since, limit=3),
    }


def device_from_user_agent(user_agent: str) -> str:
    agent = user_agent.lower()
    if "ipad" in agent or "tablet" in agent:
        return "tablet"
    if "mobi" in agent or "android" in agent or "iphone" in agent:
        return "mobile"
    return "desktop"


def looks_like_bot(user_agent: str) -> bool:
    agent = user_agent.lower()
    return not agent or any(marker in agent for marker in BOT_MARKERS)


def referrer_host(referer: str) -> str | None:
    if not referer:
        return None
    host = urlsplit(referer).hostname
    return host.lower() if host else None


def visitor_hash(env, request, day: str) -> str:
    """A per-day anonymous identifier.

    The day is part of the digest, so the same person is a different value
    tomorrow: it answers "how many distinct visitors today" without letting
    anyone follow a visitor across days.
    """

    ip = request.headers.get("CF-Connecting-IP") or ""
    agent = request.headers.get("User-Agent") or ""
    salt = _visitor_salt(env)
    return hashlib.sha256(f"{ip}|{agent}|{day}|{salt}".encode("utf-8")).hexdigest()[:32]


def request_geo(request) -> tuple[str | None, str | None]:
    try:
        cf = request.cf
        if cf is None:
            return None, None
        country = getattr(cf, "country", None)
        city = getattr(cf, "city", None)
        return (str(country) if country else None, str(city) if city else None)
    except (AttributeError, TypeError):
        return None, None


async def record_event(env, request, event_type: str, item_id: str | None = None):
    """Store at most one row per visitor, per day, per target.

    INSERT OR IGNORE against the unique index means a refresh loop writes no
    further rows. That matters because these endpoints are public and the D1
    write quota is shared with the admin session table: an unbounded counter
    here would let anyone lock the admin out of their own site.
    """

    user_agent = request.headers.get("User-Agent") or ""
    if looks_like_bot(user_agent):
        return

    try:
        day = taipei_day()
        country, city = request_geo(request)
        await env.DB.prepare(
            "INSERT OR IGNORE INTO bio_link_events"
            " (item_id, event_type, day, created_at, country, city, referrer_host, device, visitor_hash)"
            " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ).bind(
            item_id,
            event_type,
            day,
            utc_timestamp(),
            country,
            city,
            referrer_host(request.headers.get("Referer") or ""),
            device_from_user_agent(user_agent),
            visitor_hash(env, request, day),
        ).run()
    except Exception:
        # A failed insert must never cost the visitor their page or redirect.
        pass
