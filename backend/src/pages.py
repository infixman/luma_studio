"""Pages the owner builds in the back office, and the blocks they hold.

A page is a path, a title, a published flag and an ordered list of blocks.
Each block has a type and a JSON `config` whose shape depends on that type —
the fields differ wildly between a paragraph of text and a carousel, and
nothing ever queries inside them, so one column beats a table per type.

That column is the reason validation happens twice. On the way in, so a
malformed block cannot be stored; on the way out, so a block written by an
older version of this code cannot take a page down.
"""

import json
import re

import media
from bio_link import validate_url
from common import d1_rows, urlsafe_token, utc_timestamp


PAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,60}$")
PATH_PATTERN = re.compile(r"^/[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$")

MAX_PATH = 120
MAX_TITLE = 80
MAX_BLOCKS = 40
MAX_TEXT = 20000
# Preview cards cut the text off around 120 characters and LINE shows even
# less, so the limit is generous enough to write in and short enough that
# nothing important can hide past the end.
MAX_SHARE_DESCRIPTION = 200

STATUSES = ("draft", "published")

# Nothing here may be claimed by a page. A page whose path is /shop would
# shadow the entire shop, and would do it silently.
RESERVED = (
    "/shop",
    "/cart",
    "/checkout",
    "/orders",
    "/card",
    "/ibon_print",
    "/admin",
    "/api",
    "/images",
    "/r",
    "/shop-assets",
    "/media-assets",
    "/bio-link-assets",
    "/assets",
)

# One entry per block type: the validator for its config. Adding a type means
# adding a line to VALIDATORS and a component in the frontend, which is the
# whole point of getting the skeleton right before there are six of them.
TEXT = "text"
CAROUSEL = "carousel"
ALBUM = "album"
SHOP = "shop"
ABOUT = "about"

MAX_HEADING = 80
MAX_CAPTION = 120
MAX_SLIDES = 12
MAX_ALBUM_IMAGES = 60
MAX_LINKS = 8
MAX_LABEL = 30
MAX_ABOUT_BODY = 4000
MAX_SHOP_ITEMS = 24
MAX_FILTER = 200

# Appearance is chosen from a fixed set, never typed — the same rule as the
# site chrome, for the same reason: nothing the owner enters becomes CSS.
RATIOS = ("wide", "square", "tall")
COLUMNS = (2, 3, 4)
IMAGE_SIDES = ("left", "right")
SHOP_SOURCES = ("products", "category")


class PageError(Exception):
    """The page or block as submitted cannot be stored."""


def validate_id(page_id: str) -> str:
    if not PAGE_ID_PATTERN.fullmatch(page_id):
        raise PageError("Invalid id")
    return page_id


def validate_path(raw: str) -> str:
    """Normalise a page path, or refuse it.

    Lowercase, one leading slash, no trailing slash, and each segment limited
    to letters, digits and single hyphens — the same alphabet as a product
    slug, so the owner has one rule to remember rather than two.
    """

    path = str(raw).strip().lower().rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    if path == "/":
        raise PageError("首頁請用「設為首頁」，不要把路徑填成 /")
    if len(path) > MAX_PATH:
        raise PageError(f"路徑請控制在 {MAX_PATH} 個字元以內")
    if not PATH_PATTERN.fullmatch(path):
        raise PageError("路徑只能使用小寫英文、數字與連字號，例如 /about 或 /about/team")
    for reserved in RESERVED:
        if path == reserved or path.startswith(f"{reserved}/"):
            raise PageError(f"{reserved} 是系統保留路徑，不能給頁面使用")
    return path


def validate_title(raw: str) -> str:
    title = str(raw).strip()
    if not title:
        raise PageError("頁面名稱是必填")
    if len(title) > MAX_TITLE:
        raise PageError(f"頁面名稱請控制在 {MAX_TITLE} 個字以內")
    return title


def validate_status(raw: str) -> str:
    if raw not in STATUSES:
        raise PageError(f"狀態必須是 {' 或 '.join(STATUSES)}")
    return raw


def _text(raw, limit: int, label: str) -> str:
    value = str(raw or "").strip()
    if len(value) > limit:
        raise PageError(f"{label}請控制在 {limit} 個字以內")
    return value


def validate_share_description(raw) -> str:
    """The line a shared link shows under the title. May be empty.

    Empty is a real answer: a page with nothing to add is better off letting
    the crawler show the title alone than repeating it back.
    """

    return _text(raw, MAX_SHARE_DESCRIPTION, "分享文案")


def _choice(raw, allowed, label: str):
    if raw not in allowed:
        raise PageError(f"{label}必須是 {'、'.join(str(value) for value in allowed)} 其中之一")
    return raw


def _media_id(raw) -> str:
    """A media id, or empty.

    Empty is allowed: a slide whose image was deleted should still be
    editable, and the render drops it. Refusing here would leave the owner
    unable to save the block they are trying to repair.
    """

    value = str(raw or "").strip()
    if not value:
        return ""
    try:
        return media.validate_id(value)
    except media.MediaError as error:
        raise PageError(str(error)) from error


def _optional_url(raw) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    try:
        return validate_url(value)
    except ValueError as error:
        raise PageError(str(error)) from error


def _entries(raw, limit: int, label: str) -> list:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise PageError(f"{label}必須是清單")
    if len(raw) > limit:
        raise PageError(f"{label}最多 {limit} 筆")
    return raw


def _validate_text_block(config: dict) -> dict:
    body = str(config.get("body") or "")
    if len(body) > MAX_TEXT:
        raise PageError(f"文字區塊請控制在 {MAX_TEXT} 個字以內")
    return {"body": body}


def _validate_carousel(config: dict) -> dict:
    slides = []
    for entry in _entries(config.get("slides"), MAX_SLIDES, "輪播圖片"):
        if not isinstance(entry, dict):
            raise PageError("輪播的每一張都必須是物件")
        slides.append(
            {
                "mediaId": _media_id(entry.get("mediaId")),
                "caption": _text(entry.get("caption"), MAX_CAPTION, "圖說"),
                "href": _optional_url(entry.get("href")),
            }
        )
    return {
        "slides": slides,
        "ratio": _choice(str(config.get("ratio") or "wide"), RATIOS, "比例"),
        # Off by default. Something that moves on its own takes the page away
        # from whoever is reading it.
        "autoplay": bool(config.get("autoplay")),
    }


def _validate_album(config: dict) -> dict:
    ids = [_media_id(entry) for entry in _entries(config.get("mediaIds"), MAX_ALBUM_IMAGES, "相簿圖片")]
    return {
        "mediaIds": [media_id for media_id in ids if media_id],
        "columns": _choice(int(config.get("columns") or 3), COLUMNS, "每列張數"),
        "ratio": _choice(str(config.get("ratio") or "square"), RATIOS, "比例"),
    }


def _validate_shop(config: dict) -> dict:
    """A row of products, named either one by one or by category.

    The filter string is stored as typed rather than parsed into ids: `,` is
    any and `+` is all, the same grammar as the category URLs, so one rule
    covers the address bar and the block.
    """

    source = _choice(str(config.get("source") or "products"), SHOP_SOURCES, "來源")
    slugs = [
        _text(entry, 80, "商品") for entry in _entries(config.get("slugs"), MAX_SHOP_ITEMS, "商品")
    ]
    return {
        "heading": _text(config.get("heading"), MAX_HEADING, "標題"),
        "source": source,
        "slugs": [slug for slug in slugs if slug],
        "filter": _text(config.get("filter"), MAX_FILTER, "分類條件"),
        "limit": max(1, min(int(config.get("limit") or MAX_SHOP_ITEMS), MAX_SHOP_ITEMS)),
    }


def _validate_about(config: dict) -> dict:
    links = []
    for entry in _entries(config.get("links"), MAX_LINKS, "連結"):
        if not isinstance(entry, dict):
            raise PageError("每一個連結都必須是物件")
        url = _optional_url(entry.get("url"))
        label = _text(entry.get("label"), MAX_LABEL, "連結文字")
        # Both or neither: a label with no URL is a button that does nothing.
        if url and label:
            links.append({"label": label, "url": url})
    return {
        "heading": _text(config.get("heading"), MAX_HEADING, "標題"),
        "body": _text(config.get("body"), MAX_ABOUT_BODY, "內文"),
        "mediaId": _media_id(config.get("mediaId")),
        "imageSide": _choice(str(config.get("imageSide") or "left"), IMAGE_SIDES, "圖片位置"),
        "links": links,
    }


VALIDATORS = {
    TEXT: _validate_text_block,
    CAROUSEL: _validate_carousel,
    ALBUM: _validate_album,
    SHOP: _validate_shop,
    ABOUT: _validate_about,
}

BLOCK_TYPES = tuple(VALIDATORS)


def validate_block(block_type: str, config) -> tuple[str, dict]:
    """Check a block's type and config, returning both ready to store.

    Also used when reading, so a row written by an older version cannot reach
    a page. An unknown type is refused rather than passed through: a block the
    frontend has no component for renders as nothing, which looks like data
    loss to whoever wrote it.
    """

    validator = VALIDATORS.get(block_type)
    if validator is None:
        raise PageError(f"未知的區塊類型：{block_type}")
    if not isinstance(config, dict):
        raise PageError("區塊設定必須是物件")
    return block_type, validator(config)


# --- row mapping ---------------------------------------------------------


def page_row(row: dict) -> dict:
    share_key = row["share_image_key"] if "share_image_key" in row else ""
    return {
        "id": row["id"],
        "path": row["path"],
        "title": row["title"],
        "status": row["status"],
        "isHome": bool(row["is_home"]),
        # The site's header and footer are on by default and turned off per
        # page for the exceptions — a landing page that wants nothing but its
        # own content.
        "showHeader": bool(row["show_header"]) if "show_header" in row else True,
        "showFooter": bool(row["show_footer"]) if "show_footer" in row else True,
        # What a shared link shows. The key is carried alongside the URL so the
        # editor can send back the image it did not touch; only the URL is ever
        # published.
        "shareDescription": row["share_description"] if "share_description" in row else "",
        "shareImageKey": share_key,
        "shareImagePath": media.image_path(share_key),
        "position": int(row["position"]),
        "updatedAt": int(row["updated_at"]),
    }


def block_row(row: dict) -> dict | None:
    """One block, or None when its stored config no longer makes sense.

    Returning None rather than raising lets a page with one bad block still
    render the rest. The alternative is that a single stale row takes down a
    published page, which is a worse failure than a missing paragraph.
    """

    try:
        block_type, config = validate_block(row["type"], json.loads(row["config"]))
    except (PageError, ValueError):
        return None
    return {"id": row["id"], "type": block_type, "config": config, "position": int(row["position"])}


# --- reading -------------------------------------------------------------


async def list_pages(env, *, only_published: bool = False) -> list[dict]:
    query = "SELECT * FROM pages"
    if only_published:
        query += " WHERE status = 'published'"
    query += " ORDER BY position, title, id"
    return [page_row(row) for row in await d1_rows(env.DB.prepare(query))]


async def get_page(env, page_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM pages WHERE id = ?1").bind(page_id))
    return page_row(rows[0]) if rows else None


async def page_by_path(env, path: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM pages WHERE path = ?1").bind(path))
    return page_row(rows[0]) if rows else None


async def home_page(env) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM pages WHERE is_home = 1"))
    return page_row(rows[0]) if rows else None


async def path_taken(env, path: str, *, excluding: str | None = None) -> bool:
    rows = await d1_rows(
        env.DB.prepare("SELECT id FROM pages WHERE path = ?1 AND id != ?2").bind(path, excluding or "")
    )
    return bool(rows)


async def list_blocks(env, page_id: str) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM page_blocks WHERE page_id = ?1 ORDER BY position, id").bind(page_id)
    )
    return [block for block in (block_row(row) for row in rows) if block is not None]


async def get_block(env, block_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM page_blocks WHERE id = ?1").bind(block_id))
    if not rows:
        return None
    block = block_row(rows[0])
    # The editor still needs to see a block it can no longer render, so that
    # it can be deleted rather than haunting the page invisibly.
    return block or {"id": rows[0]["id"], "type": rows[0]["type"], "config": {}, "position": int(rows[0]["position"])}


async def count_blocks(env, page_id: str) -> int:
    rows = await d1_rows(env.DB.prepare("SELECT COUNT(*) AS total FROM page_blocks WHERE page_id = ?1").bind(page_id))
    return int(rows[0]["total"]) if rows else 0


# --- preview tokens ------------------------------------------------------

# Long enough to walk to the browser and look, short enough that a token left
# in a chat window is worthless by the time anybody tries it.
PREVIEW_TTL_SECONDS = 10 * 60

PREVIEW_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,64}$")


async def mint_preview_token(env, page_id: str) -> str:
    """A one-shot pass to look at one unpublished page on the real storefront.

    The back office cannot show what the storefront will actually do — it
    renders the blocks with the same components, but not inside the site's
    own chrome and background. Framing the real thing is the only way to see
    the real thing, and the real thing refuses to serve a draft, so it needs
    to be handed something.

    Bounded on three sides: one page, ten minutes, and spent on use. None of
    the three is load-bearing on its own.
    """

    now = utc_timestamp()
    # Cheap enough to do on every mint, and it means nothing has to remember
    # to sweep this table on a schedule.
    await env.DB.prepare("DELETE FROM preview_tokens WHERE expires_at < ?1").bind(now).run()

    token = urlsafe_token(32)
    await env.DB.prepare("INSERT INTO preview_tokens (token, page_id, expires_at) VALUES (?1, ?2, ?3)").bind(
        token, page_id, now + PREVIEW_TTL_SECONDS
    ).run()
    return token


async def redeem_preview_token(env, token: str) -> str | None:
    """The page id a token stands for, or None. Spends the token either way.

    Deleting before the expiry check rather than after: a token that arrives
    late is still a token that has now been used, and leaving it behind would
    let a slow attempt be retried until it raced a clock.
    """

    if not PREVIEW_TOKEN_PATTERN.fullmatch(token or ""):
        return None

    rows = await d1_rows(env.DB.prepare("SELECT * FROM preview_tokens WHERE token = ?1").bind(token))
    await env.DB.prepare("DELETE FROM preview_tokens WHERE token = ?1").bind(token).run()
    if not rows:
        return None
    if int(rows[0]["expires_at"]) < utc_timestamp():
        return None
    return str(rows[0]["page_id"])


async def resolve_share_image_key(env, raw) -> str:
    """Turn the media id the picker handed the editor into a stored key.

    The page keeps the key rather than the id because every crawl needs a URL,
    and the key is one lookup away from being a URL while an id is two. An id
    with nothing behind it is refused rather than stored: an image the owner
    can see in the picker but not in the preview is worse than an error.
    """

    media_id = _media_id(raw)
    if not media_id:
        return ""
    key = await media.object_key_of(env, media_id)
    if key is None:
        raise PageError("找不到這張圖片，請重新選一次")
    return key


async def page_id_of_block(env, block_id: str) -> str | None:
    rows = await d1_rows(env.DB.prepare("SELECT page_id FROM page_blocks WHERE id = ?1").bind(block_id))
    return rows[0]["page_id"] if rows else None


# --- writing -------------------------------------------------------------


async def create_page(env, *, path: str, title: str, status: str) -> str:
    rows = await d1_rows(env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM pages"))
    position = (int(rows[0]["last"]) if rows else -1) + 1
    page_id, now = urlsafe_token(18), utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO pages (id, path, title, status, is_home, position, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)"
    ).bind(page_id, path, title, status, position, now).run()
    return page_id


async def update_page(
    env,
    page_id: str,
    *,
    path: str,
    title: str,
    status: str,
    show_header: bool = True,
    show_footer: bool = True,
    share_description: str = "",
    share_image_key: str = "",
) -> bool:
    if await get_page(env, page_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE pages SET path = ?2, title = ?3, status = ?4, show_header = ?5, show_footer = ?6,"
        " share_description = ?7, share_image_key = ?8, updated_at = ?9"
        " WHERE id = ?1"
    ).bind(
        page_id,
        path,
        title,
        status,
        1 if show_header else 0,
        1 if show_footer else 0,
        share_description,
        share_image_key,
        utc_timestamp(),
    ).run()
    return True


async def set_home(env, page_id: str) -> None:
    """Make one page the home page, and no other.

    The unique index would reject the second row on its own; clearing first
    means the owner gets the move they asked for rather than an error telling
    them to undo something else first.
    """

    now = utc_timestamp()
    await env.DB.prepare("UPDATE pages SET is_home = 0, updated_at = ?1 WHERE is_home = 1").bind(now).run()
    await env.DB.prepare("UPDATE pages SET is_home = 1, updated_at = ?2 WHERE id = ?1").bind(page_id, now).run()


async def clear_home(env, page_id: str) -> None:
    await env.DB.prepare("UPDATE pages SET is_home = 0, updated_at = ?2 WHERE id = ?1").bind(
        page_id, utc_timestamp()
    ).run()


async def delete_page(env, page_id: str) -> bool:
    if await get_page(env, page_id) is None:
        return False
    # Blocks first: a block pointing at a page that is gone is harder to find
    # than a page whose blocks have not been cleaned up yet.
    await env.DB.prepare("DELETE FROM page_blocks WHERE page_id = ?1").bind(page_id).run()
    await env.DB.prepare("DELETE FROM pages WHERE id = ?1").bind(page_id).run()
    return True


async def reorder_pages(env, ordered_ids: list[str]) -> None:
    now = utc_timestamp()
    for index, page_id in enumerate(ordered_ids):
        await env.DB.prepare("UPDATE pages SET position = ?2, updated_at = ?3 WHERE id = ?1").bind(
            page_id, index, now
        ).run()


async def touch_page(env, page_id: str) -> None:
    """Mark the page as changed. Editing a block is editing the page."""

    await env.DB.prepare("UPDATE pages SET updated_at = ?2 WHERE id = ?1").bind(page_id, utc_timestamp()).run()


async def add_block(env, page_id: str, block_type: str, config: dict) -> str:
    rows = await d1_rows(
        env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM page_blocks WHERE page_id = ?1").bind(page_id)
    )
    position = (int(rows[0]["last"]) if rows else -1) + 1
    block_id = urlsafe_token(18)
    await env.DB.prepare(
        "INSERT INTO page_blocks (id, page_id, type, config, position) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(block_id, page_id, block_type, json.dumps(config, ensure_ascii=False), position).run()
    await touch_page(env, page_id)
    return block_id


async def update_block(env, block_id: str, config: dict) -> bool:
    page_id = await page_id_of_block(env, block_id)
    if page_id is None:
        return False
    await env.DB.prepare("UPDATE page_blocks SET config = ?2 WHERE id = ?1").bind(
        block_id, json.dumps(config, ensure_ascii=False)
    ).run()
    await touch_page(env, page_id)
    return True


async def delete_block(env, block_id: str) -> bool:
    page_id = await page_id_of_block(env, block_id)
    if page_id is None:
        return False
    await env.DB.prepare("DELETE FROM page_blocks WHERE id = ?1").bind(block_id).run()
    await touch_page(env, page_id)
    return True


async def reorder_blocks(env, page_id: str, ordered_ids: list[str]) -> None:
    for index, block_id in enumerate(ordered_ids):
        await env.DB.prepare("UPDATE page_blocks SET position = ?2 WHERE id = ?1 AND page_id = ?3").bind(
            block_id, index, page_id
        ).run()
    await touch_page(env, page_id)
