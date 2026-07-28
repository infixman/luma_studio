"""The media library: images uploaded once and used by several blocks.

Product photos belong to a product and the header image belongs to the header,
so each of those stores its own R2 key. A carousel is different — the same
photograph turns up in a carousel, an album and an introduction block, and
uploading it three times means correcting it three times.

So blocks store a media id, not a URL. The id survives everything the owner
can do to the file afterwards, and a page can be told that the image it points
at is gone instead of quietly rendering a broken picture.
"""

import json

from common import d1_rows, urlsafe_token, utc_timestamp


MEDIA_ID_PATTERN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

MAX_ALT = 200
MAX_FILE_NAME = 120
MAX_ITEMS = 300

# Same underscore trick as the shop and the header image: the prefix keeps
# these out of IDENTIFIER_PATTERN, so a library image can never be reached
# through the ibon /images/ route or mistaken for a print folder.
OBJECT_PREFIX = "_media"
IMAGE_URL_PREFIX = "/media-assets"

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
IMAGE_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class MediaError(Exception):
    """The upload or the change as submitted cannot be stored."""


# --- validation ----------------------------------------------------------


def validate_id(media_id: str) -> str:
    raw = str(media_id)
    if not 10 <= len(raw) <= 60 or any(character not in MEDIA_ID_PATTERN_CHARS for character in raw):
        raise MediaError("Invalid media id")
    return raw


def validate_image_suffix(file_name: str) -> str:
    name = str(file_name)
    suffix = name[name.rfind(".") :].lower()
    if "/" in name or ".." in name or suffix not in IMAGE_SUFFIXES:
        raise MediaError("圖片必須是 jpg、png 或 webp")
    return suffix


def validate_alt(raw) -> str:
    """Alt text, which may be empty.

    Empty is a real answer: a purely decorative image is better with an empty
    alt than with a filename read out by a screen reader. The back office says
    so rather than nagging for text that would be noise.
    """

    alt = str(raw or "").strip()
    if len(alt) > MAX_ALT:
        raise MediaError(f"替代文字請控制在 {MAX_ALT} 個字以內")
    return alt


def clean_file_name(raw) -> str:
    """The original name, kept only to be shown in the library.

    Nothing is ever read from disk by this name — the stored object gets a
    generated key — so the only job here is to keep it printable and short.
    """

    name = str(raw or "").strip().replace("\\", "/")
    name = name[name.rfind("/") + 1 :]
    name = "".join(character for character in name if character.isprintable())
    return name[:MAX_FILE_NAME] or "image"


# --- keys and URLs -------------------------------------------------------


def object_key(suffix: str) -> str:
    return f"{OBJECT_PREFIX}/{urlsafe_token(12)}{suffix}"


def image_path(key: str) -> str | None:
    if not key or not key.startswith(f"{OBJECT_PREFIX}/"):
        return None
    return f"{IMAGE_URL_PREFIX}/{key.removeprefix(f'{OBJECT_PREFIX}/')}"


def content_type_for(file_name: str) -> str | None:
    suffix = file_name[file_name.rfind(".") :].lower()
    return IMAGE_CONTENT_TYPES.get(suffix)


# --- row mapping ---------------------------------------------------------


def media_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "path": image_path(row["object_key"]),
        "fileName": row["file_name"],
        "alt": row["alt"],
        "byteSize": int(row["byte_size"]),
        "createdAt": int(row["created_at"]),
    }


# --- reading -------------------------------------------------------------


async def list_media(env) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM media ORDER BY created_at DESC, id LIMIT ?1").bind(MAX_ITEMS)
    )
    return [media_row(row) for row in rows]


async def get_media(env, media_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM media WHERE id = ?1").bind(media_id))
    return media_row(rows[0]) if rows else None


async def resolve(env, media_ids) -> dict:
    """Map ids to the rows behind them, skipping ids with nothing behind them.

    Callers rendering a block use this to turn stored ids into URLs. An id that
    resolves to nothing is left out of the result, and the block drops that
    picture rather than drawing a broken one.
    """

    wanted = [media_id for media_id in dict.fromkeys(media_ids) if media_id]
    if not wanted:
        return {}
    placeholders = ", ".join(f"?{index + 1}" for index in range(len(wanted)))
    rows = await d1_rows(env.DB.prepare(f"SELECT * FROM media WHERE id IN ({placeholders})").bind(*wanted))
    return {row["id"]: media_row(row) for row in rows}


async def key_is_known(env, key: str) -> bool:
    """Whether the bucket key belongs to the library.

    The public image route checks this before reading the object, so a guessed
    or stale URL cannot be used to fish around in a bucket that also holds ibon
    print jobs.
    """

    rows = await d1_rows(env.DB.prepare("SELECT 1 FROM media WHERE object_key = ?1").bind(key))
    return bool(rows)


async def object_key_of(env, media_id: str) -> str | None:
    rows = await d1_rows(env.DB.prepare("SELECT object_key FROM media WHERE id = ?1").bind(media_id))
    return rows[0]["object_key"] if rows else None


# --- usage ---------------------------------------------------------------


async def usage(env, media_id: str) -> list[dict]:
    """Which pages use this image.

    The ids live inside each block's JSON config, so this reads the configs and
    looks in them rather than asking SQL to search text it does not understand.
    The library holds hundreds of rows, not millions; a scan is honest here and
    a LIKE against JSON would match an id that merely appears inside a longer
    string.
    """

    rows = await d1_rows(
        env.DB.prepare(
            """SELECT pages.id AS page_id, pages.title AS title, pages.path AS path,
                      page_blocks.config AS config
                 FROM page_blocks
                 JOIN pages ON pages.id = page_blocks.page_id"""
        )
    )

    seen: dict[str, dict] = {}
    for row in rows:
        try:
            config = json.loads(row["config"])
        except ValueError:
            continue
        if _mentions(config, media_id):
            seen[row["page_id"]] = {"id": row["page_id"], "title": row["title"], "path": row["path"]}
    return sorted(seen.values(), key=lambda page: page["path"])


def _mentions(config, media_id: str) -> bool:
    """Whether a block config refers to this media id, wherever it sits.

    Written against the shape of JSON rather than against any one block type,
    so a block type added later is covered without being remembered here.
    """

    if isinstance(config, str):
        return config == media_id
    if isinstance(config, dict):
        return any(_mentions(value, media_id) for value in config.values())
    if isinstance(config, (list, tuple)):
        return any(_mentions(value, media_id) for value in config)
    return False


# --- writing -------------------------------------------------------------


async def create(env, *, object_key: str, file_name: str, alt: str, byte_size: int) -> dict:
    media_id = urlsafe_token(12)
    await env.DB.prepare(
        """INSERT INTO media (id, object_key, file_name, alt, byte_size, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)"""
    ).bind(media_id, object_key, file_name, alt, int(byte_size), utc_timestamp()).run()
    return (await get_media(env, media_id)) or {}


async def set_alt(env, media_id: str, alt: str) -> bool:
    result = await env.DB.prepare("UPDATE media SET alt = ?2 WHERE id = ?1").bind(media_id, alt).run()
    return bool(result.meta.changes)


async def delete(env, media_id: str) -> str | None:
    """Remove the row, returning the R2 key that is now unreferenced.

    The row goes first. An orphaned object costs storage; an orphaned row is a
    picture the library offers and the site cannot draw.
    """

    key = await object_key_of(env, media_id)
    if key is None:
        return None
    await env.DB.prepare("DELETE FROM media WHERE id = ?1").bind(media_id).run()
    return key
