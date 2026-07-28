"""The media library: images uploaded once and used by several blocks.

Product photos belong to a product and the header image belongs to the header,
so each of those stores its own R2 key. A carousel is different — the same
photograph turns up in a carousel, an album and an introduction block, and
uploading it three times means correcting it three times.

So blocks store a media id, not a URL. The id survives everything the owner
can do to the file afterwards, and a page can be told that the image it points
at is gone instead of quietly rendering a broken picture.

Finding one again is done with a title and tags rather than folders. A drawing
is both "插畫" and "首頁用" at once, which a folder cannot be; and there is no
such thing as moving a picture, or deleting a folder that still has pictures
in it, when there are no folders.
"""

import json

from common import d1_rows, urlsafe_token, utc_timestamp


MEDIA_ID_PATTERN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

MAX_ALT = 200
MAX_TITLE = 120
MAX_FILE_NAME = 120
MAX_ITEMS = 300
MAX_SEARCH = 60

# Short enough that a tag stays a label rather than becoming a sentence, and
# few enough that the list under an image is still readable at a glance.
MAX_TAG = 30
MAX_TAGS = 10

# Tags come back from SQL as one string per row. A newline is safe as the
# separator because `normalise_tag` collapses every run of whitespace into a
# single space, so no tag can contain one.
TAG_SEPARATOR = "\n"

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


def validate_title(raw) -> str:
    """The owner's own name for the image, which may be empty.

    Not the same field as alt and never merged with it: alt is read out to
    somebody who cannot see the picture, this is what the owner types into the
    search box. Empty is fine — the file name stands in.
    """

    title = " ".join(str(raw or "").split())
    if len(title) > MAX_TITLE:
        raise MediaError(f"標題請控制在 {MAX_TITLE} 個字以內")
    return title


def normalise_tag(raw) -> str:
    """One tag, reduced to the single form it is stored and searched as.

    Everything here exists so that two people typing the same tag get the same
    row: the spacing is collapsed, and ASCII letters are folded to lower case
    so "Banner" and "banner" are one tag rather than two that look identical
    in a list. Only ASCII is folded — full Unicode lowering would fold pairs
    we never meant to fold, and the tags that matter here are Chinese, which
    has no case to fold.

    Over-long input is cut rather than refused. The input in the back office
    stops at the same length, so this only catches what arrives another way.
    """

    text = " ".join(str(raw or "").split())
    folded = "".join(character.lower() if "A" <= character <= "Z" else character for character in text)
    return folded[:MAX_TAG]


def validate_tags(raw) -> list[str]:
    """The tags of one image, in the order they were given.

    Duplicates are dropped rather than refused — two spellings of one tag are
    the same tag once normalised, and saying so would be pedantry about
    something already fixed.
    """

    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)):
        raise MediaError("標籤格式不正確")
    tags = [tag for tag in dict.fromkeys(normalise_tag(item) for item in raw) if tag]
    if len(tags) > MAX_TAGS:
        raise MediaError(f"一張圖最多 {MAX_TAGS} 個標籤")
    return tags


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
        "title": row.get("title") or "",
        "alt": row["alt"],
        "tags": _split_tags(row.get("tags")),
        "byteSize": int(row["byte_size"]),
        "createdAt": int(row["created_at"]),
    }


def _split_tags(joined) -> list[str]:
    if not joined:
        return []
    # Sorted here rather than in SQL: group_concat promises nothing about the
    # order it joins in, and a list that reshuffles between two loads of the
    # same page looks like the data changed.
    return sorted({tag for tag in str(joined).split(TAG_SEPARATOR) if tag})


# --- reading -------------------------------------------------------------


# Tags come along with the row rather than in a second query. The library is
# read a grid at a time, and one round trip per image is the shape of query
# that D1 charges for.
_SELECT = """SELECT media.*,
                    (SELECT group_concat(tag, char(10)) FROM media_tags WHERE media_id = media.id) AS tags
               FROM media"""


async def list_media(env, *, search: str = "") -> tuple[list[dict], bool]:
    """The library, and whether it was cut short."""

    where, bindings = _search_clause(search)
    bindings.append(MAX_ITEMS + 1)
    rows = await d1_rows(
        env.DB.prepare(
            f"{_SELECT}{where} ORDER BY media.created_at DESC, media.id LIMIT ?{len(bindings)}"
        ).bind(*bindings)
    )
    return [media_row(row) for row in rows[:MAX_ITEMS]], len(rows) > MAX_ITEMS


def _search_clause(search: str) -> tuple[str, list]:
    """What `q` matches, and the values behind it.

    Three things, because they are the three ways an owner remembers an image:
    the label they gave it, the name their camera gave it, and a tag.

    The tag half is an exact match, not a LIKE. That is the whole reason the
    tags are a table: searching 貓 must not answer with everything tagged
    熊貓. So the term is put through the same normaliser the tags were stored
    with, and compared as a whole.
    """

    term = str(search or "").strip()[:MAX_SEARCH]
    if not term:
        return "", []
    return (
        """ WHERE media.title LIKE ?1 OR media.file_name LIKE ?1
              OR EXISTS (SELECT 1 FROM media_tags WHERE media_id = media.id AND tag = ?2)""",
        [f"%{term}%", normalise_tag(term)],
    )


async def get_media(env, media_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare(f"{_SELECT} WHERE media.id = ?1").bind(media_id))
    return media_row(rows[0]) if rows else None


async def list_tags(env) -> list[str]:
    """Every tag in use, most used first.

    This is what the tag box offers while somebody types. Ordered by use
    rather than alphabetically because the tag you want is usually one you
    have used before, and only the first few suggestions get read.
    """

    rows = await d1_rows(
        env.DB.prepare("SELECT tag, COUNT(*) AS uses FROM media_tags GROUP BY tag ORDER BY uses DESC, tag")
    )
    return [row["tag"] for row in rows]


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
    # Plain columns, not `_SELECT`: this runs on the public Worker every time a
    # page with pictures is drawn, and nothing out there renders a tag. Rows
    # from here come back with an empty tag list, which is what they are worth.
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


async def create(env, *, object_key: str, file_name: str, title: str, alt: str, byte_size: int) -> dict:
    media_id = urlsafe_token(12)
    await env.DB.prepare(
        """INSERT INTO media (id, object_key, file_name, title, alt, byte_size, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"""
    ).bind(media_id, object_key, file_name, title, alt, int(byte_size), utc_timestamp()).run()
    return (await get_media(env, media_id)) or {}


async def update(env, media_id: str, *, title: str, alt: str, tags: list[str]) -> bool:
    """Save the three things the owner can change about an image.

    One call rather than one per field: they are edited in one form, and three
    endpoints would mean a half-saved image whenever the second request failed.
    """

    result = await (
        env.DB.prepare("UPDATE media SET title = ?2, alt = ?3 WHERE id = ?1").bind(media_id, title, alt).run()
    )
    if not result.meta.changes:
        return False
    await _replace_tags(env, media_id, tags)
    return True


async def _replace_tags(env, media_id: str, tags: list[str]):
    """The tags submitted become the tags stored, whatever was there before.

    Working out which ones were added and which removed would be two more
    queries to arrive at the same rows. Ten is the ceiling, so replacing the
    lot is one delete and one insert.
    """

    await env.DB.prepare("DELETE FROM media_tags WHERE media_id = ?1").bind(media_id).run()
    if not tags:
        return
    values = ", ".join(f"(?1, ?{index + 2})" for index in range(len(tags)))
    await env.DB.prepare(f"INSERT OR IGNORE INTO media_tags (media_id, tag) VALUES {values}").bind(
        media_id, *tags
    ).run()


async def delete(env, media_id: str) -> str | None:
    """Remove the row, returning the R2 key that is now unreferenced.

    The row goes first. An orphaned object costs storage; an orphaned row is a
    picture the library offers and the site cannot draw.
    """

    key = await object_key_of(env, media_id)
    if key is None:
        return None
    await env.DB.prepare("DELETE FROM media WHERE id = ?1").bind(media_id).run()
    # D1 does not enforce foreign keys here, so the tags have to be cleared by
    # hand. Left behind they would keep offering a tag in the autocomplete
    # that no image carries any more.
    await env.DB.prepare("DELETE FROM media_tags WHERE media_id = ?1").bind(media_id).run()
    return key
