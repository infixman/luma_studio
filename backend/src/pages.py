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

from common import d1_rows, urlsafe_token, utc_timestamp


PAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,60}$")
PATH_PATTERN = re.compile(r"^/[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$")

MAX_PATH = 120
MAX_TITLE = 80
MAX_BLOCKS = 40
MAX_TEXT = 20000

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
# adding a line here and a component in the frontend, which is the whole point
# of getting the skeleton right before there are six of them.
TEXT = "text"


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


def validate_block(block_type: str, config) -> tuple[str, dict]:
    """Check a block's type and config, returning both ready to store.

    Also used when reading, so a row written by an older version cannot reach
    a page. An unknown type is refused rather than passed through: a block the
    frontend has no component for renders as nothing, which looks like data
    loss to whoever wrote it.
    """

    if block_type != TEXT:
        raise PageError(f"未知的區塊類型：{block_type}")
    if not isinstance(config, dict):
        raise PageError("區塊設定必須是物件")

    body = str(config.get("body") or "")
    if len(body) > MAX_TEXT:
        raise PageError(f"文字區塊請控制在 {MAX_TEXT} 個字以內")
    return block_type, {"body": body}


# --- row mapping ---------------------------------------------------------


def page_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "path": row["path"],
        "title": row["title"],
        "status": row["status"],
        "isHome": bool(row["is_home"]),
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


async def update_page(env, page_id: str, *, path: str, title: str, status: str) -> bool:
    if await get_page(env, page_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE pages SET path = ?2, title = ?3, status = ?4, updated_at = ?5 WHERE id = ?1"
    ).bind(page_id, path, title, status, utc_timestamp()).run()
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
