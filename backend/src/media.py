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

Each image is stored several times over at different widths. The scaling is
done by the browser before the upload, so nothing here decodes an image: this
module takes the bytes it is handed and the dimensions it is told, and the
only thing it enforces is that both are within reason.
"""

import json

from common import d1_rows, urlsafe_token, utc_timestamp


MEDIA_ID_PATTERN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"

MAX_ALT = 200
MAX_TITLE = 120
MAX_FILE_NAME = 120
MAX_ITEMS = 300
MAX_SEARCH = 60

# One screenful of a grid, generously. Select-all selects what is on screen,
# and what is on screen is capped by MAX_ITEMS, so this only has to be larger
# than any selection a person makes on purpose.
MAX_BULK = 100

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

# The three widths the browser renders, named rather than numbered so that
# changing 960 later does not have to rewrite every stored row. A closed set
# because the label is half of a primary key and part of an object key: an
# upload naming its own labels could write as many objects as it liked under
# one image.
SIZE_LABELS = ("small", "medium", "large")

# Variants are webp and narrower than the original, so one that reaches the
# original's ceiling is not a resize — it is something else being posted at
# this field. Same number rather than a smaller one because the ceiling is
# about what the bucket will accept, not about what a good variant looks like.
MAX_VARIANT_BYTES = MAX_IMAGE_BYTES

# Wide enough for anything a camera or a scanner produces, narrow enough that
# a mistyped dimension cannot be stored as fact. Nothing here decodes the
# image, so this is the only check there can be.
MAX_DIMENSION = 20000

VARIANT_SUFFIX = ".webp"


class MediaError(Exception):
    """The upload or the change as submitted cannot be stored."""


# --- validation ----------------------------------------------------------


def validate_id(media_id: str) -> str:
    raw = str(media_id)
    if not 10 <= len(raw) <= 60 or any(character not in MEDIA_ID_PATTERN_CHARS for character in raw):
        raise MediaError("Invalid media id")
    return raw


def validate_ids(raw) -> list[str]:
    """The images one bulk action is about.

    Capped because the whole selection is answered for in one response, and an
    unbounded list is an unbounded response — and, for the delete, an
    unbounded number of bucket calls inside one request.
    """

    if not isinstance(raw, (list, tuple)):
        raise MediaError("Invalid media ids")
    ids = [validate_id(item) for item in dict.fromkeys(str(item) for item in raw)]
    if not ids:
        raise MediaError("沒有選取任何圖片")
    if len(ids) > MAX_BULK:
        raise MediaError(f"一次最多處理 {MAX_BULK} 張圖片")
    return ids


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


def validate_dimensions(raw) -> tuple[int, int]:
    """A "1024x768" from the browser, as two numbers.

    Nothing arrives measured. A Python Worker has no image library, so the
    pixels are whatever the browser that did the scaling says they are, and
    this only refuses values that could not describe a picture.

    An absent or unreadable value is (0, 0) rather than an error, and (0, 0)
    means "not measured". Refusing would mean that a file the browser cannot
    decode — the one case where the owner most wants the original kept safely
    somewhere — is the one file the library will not accept.
    """

    text = str(raw or "").strip().lower()
    width, _, height = text.partition("x")
    if not width.isdigit() or not height.isdigit():
        return (0, 0)
    pixels = (int(width), int(height))
    if not all(0 < value <= MAX_DIMENSION for value in pixels):
        return (0, 0)
    return pixels


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


def variant_key(label: str) -> str:
    """A key of its own for each width, not the original's key plus a suffix.

    Deriving one key from another reads well right up to the moment an owner
    replaces an image: the derived keys would collide with the previous
    version's, and the edge would keep serving whichever it cached. Separate
    tokens make every stored object independent of every other.
    """

    return f"{OBJECT_PREFIX}/{urlsafe_token(12)}-{label}{VARIANT_SUFFIX}"


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
        # Zero for anything uploaded before the browser started measuring, and
        # for anything it could not decode. Callers show what they have rather
        # than pretending to a number they were never given.
        "width": int(row.get("width") or 0),
        "height": int(row.get("height") or 0),
        "sizes": _split_sizes(row.get("sizes")),
        "createdAt": int(row["created_at"]),
    }


def _split_tags(joined) -> list[str]:
    if not joined:
        return []
    # Sorted here rather than in SQL: group_concat promises nothing about the
    # order it joins in, and a list that reshuffles between two loads of the
    # same page looks like the data changed.
    return sorted({tag for tag in str(joined).split(TAG_SEPARATOR) if tag})


def _split_sizes(joined) -> list[dict]:
    """The variants of one image, narrowest first.

    They arrive as one string per row for the same reason the tags do — the
    library is read a grid at a time and D1 charges per round trip — so this
    is the other half of the `group_concat` in `_SIZES`. Fields are separated
    by spaces, which nothing stored here can contain: the labels are a closed
    set, the keys are generated tokens and the rest are numbers.

    A piece that does not parse is dropped rather than raised on. A missing
    width costs one entry in a srcset; an exception costs the whole page.
    """

    if not joined:
        return []
    sizes = []
    for part in str(joined).split(TAG_SEPARATOR):
        fields = part.split(" ")
        if len(fields) != 5:
            continue
        label, key, width, height, byte_size = fields
        path = image_path(key)
        if path is None or not (width.isdigit() and height.isdigit() and byte_size.isdigit()):
            continue
        sizes.append(
            {
                "label": label,
                "path": path,
                "width": int(width),
                "height": int(height),
                "byteSize": int(byte_size),
            }
        )
    # Narrowest first, because that is the order a srcset is read in and the
    # order group_concat does not promise.
    return sorted(sizes, key=lambda size: size["width"])


# --- reading -------------------------------------------------------------


# Tags and sizes come along with the row rather than in a second query. The
# library is read a grid at a time, and one round trip per image is the shape
# of query that D1 charges for.
_TAGS = "(SELECT group_concat(tag, char(10)) FROM media_tags WHERE media_id = media.id) AS tags"
_SIZES = """(SELECT group_concat(
                      label || ' ' || object_key || ' ' || width || ' ' || height || ' ' || byte_size,
                      char(10))
               FROM media_sizes WHERE media_id = media.id) AS sizes"""

_SELECT = f"SELECT media.*, {_TAGS}, {_SIZES} FROM media"


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
    # The sizes but not the tags. This runs on the public Worker every time a
    # page with pictures is drawn: nothing out there renders a tag, but the
    # sizes are the entire reason they exist — a storefront that cannot see
    # them serves the phone the full-width original. Rows from here come back
    # with an empty tag list, which is what a tag is worth on the storefront.
    rows = await d1_rows(
        env.DB.prepare(f"SELECT media.*, {_SIZES} FROM media WHERE id IN ({placeholders})").bind(*wanted)
    )
    return {row["id"]: media_row(row) for row in rows}


async def key_is_known(env, key: str) -> bool:
    """Whether the bucket key belongs to the library.

    The public image route checks this before reading the object, so a guessed
    or stale URL cannot be used to fish around in a bucket that also holds ibon
    print jobs.

    Both tables, because a srcset points a customer's browser straight at the
    variants: an answer that only knew about originals would turn every
    responsive image on the site into a 404.
    """

    rows = await d1_rows(
        env.DB.prepare(
            """SELECT 1 FROM media WHERE object_key = ?1
               UNION ALL
               SELECT 1 FROM media_sizes WHERE object_key = ?1
               LIMIT 1"""
        ).bind(key)
    )
    return bool(rows)


async def object_key_of(env, media_id: str) -> str | None:
    rows = await d1_rows(env.DB.prepare("SELECT object_key FROM media WHERE id = ?1").bind(media_id))
    return rows[0]["object_key"] if rows else None


# --- usage ---------------------------------------------------------------


async def usage(env, media_id: str) -> list[dict]:
    """Which pages use this image."""

    return (await usage_of(env, [media_id])).get(media_id, [])


async def usage_of(env, media_ids) -> dict[str, list[dict]]:
    """Which pages use each of these images, in one pass over the blocks.

    The ids live inside each block's JSON config, so this reads the configs and
    looks in them rather than asking SQL to search text it does not understand.
    The library holds hundreds of rows, not millions; a scan is honest here and
    a LIKE against JSON would match an id that merely appears inside a longer
    string.

    Several ids at once because deleting a selection asks the same question
    about each of them, and the expensive half — reading and parsing every
    block on the site — is the half that does not depend on which id is being
    asked about. Ten images used to mean ten scans.
    """

    wanted = [media_id for media_id in dict.fromkeys(media_ids) if media_id]
    found: dict[str, dict[str, dict]] = {media_id: {} for media_id in wanted}
    if not wanted:
        return {}

    rows = await d1_rows(
        env.DB.prepare(
            """SELECT pages.id AS page_id, pages.title AS title, pages.path AS path,
                      page_blocks.config AS config
                 FROM page_blocks
                 JOIN pages ON pages.id = page_blocks.page_id"""
        )
    )

    for row in rows:
        try:
            config = json.loads(row["config"])
        except ValueError:
            continue
        page = {"id": row["page_id"], "title": row["title"], "path": row["path"]}
        for media_id in wanted:
            if _mentions(config, media_id):
                found[media_id][row["page_id"]] = page
    return {
        media_id: sorted(pages.values(), key=lambda page: page["path"]) for media_id, pages in found.items()
    }


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


async def create(
    env,
    *,
    object_key: str,
    file_name: str,
    title: str,
    alt: str,
    byte_size: int,
    width: int = 0,
    height: int = 0,
    sizes=(),
) -> dict:
    media_id = urlsafe_token(12)
    await env.DB.prepare(
        """INSERT INTO media (id, object_key, file_name, title, alt, byte_size, width, height, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"""
    ).bind(
        media_id,
        object_key,
        file_name,
        title,
        alt,
        int(byte_size),
        int(width),
        int(height),
        utc_timestamp(),
    ).run()
    for size in sizes:
        # One statement each rather than one long VALUES list. Three rows is
        # not where a round trip is worth saving, and a variant that fails to
        # record leaves the others recorded — the image is still shown, one
        # width worse off, instead of losing all of them together.
        await env.DB.prepare(
            """INSERT OR REPLACE INTO media_sizes (media_id, label, object_key, width, height, byte_size)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)"""
        ).bind(
            media_id,
            size["label"],
            size["object_key"],
            int(size["width"]),
            int(size["height"]),
            int(size["byte_size"]),
        ).run()
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


async def delete(env, media_id: str) -> list[str] | None:
    """Remove the row, returning every R2 key that is now unreferenced.

    A list rather than one key, because an image is stored once per width. The
    caller deletes what it is handed; a variant left behind would be storage
    nobody can reach, since the row that named it is gone.

    The rows go first. An orphaned object costs storage; an orphaned row is a
    picture the library offers and the site cannot draw. `None` means there
    was no such image, which is not the same as an image with no variants.
    """

    key = await object_key_of(env, media_id)
    if key is None:
        return None
    variants = await d1_rows(
        env.DB.prepare("SELECT object_key FROM media_sizes WHERE media_id = ?1").bind(media_id)
    )
    await env.DB.prepare("DELETE FROM media WHERE id = ?1").bind(media_id).run()
    # D1 does not enforce foreign keys here, so the tags and the sizes have to
    # be cleared by hand. A tag left behind would keep being offered by the
    # autocomplete with no image carrying it; a size left behind would keep
    # the public image route serving a variant of a deleted picture.
    await env.DB.prepare("DELETE FROM media_tags WHERE media_id = ?1").bind(media_id).run()
    await env.DB.prepare("DELETE FROM media_sizes WHERE media_id = ?1").bind(media_id).run()
    return [key, *(row["object_key"] for row in variants)]
