"""The header and footer every page wears, and the menu inside the header.

Named `site_chrome` rather than `site` because `site` is a standard library
module that Python imports during interpreter start-up — `import site` would
always resolve to that one, whatever is on the path.

These are site settings, not blocks a page includes. A header you have to
remember to insert is a header you will one day forget to insert, and the
page that goes out without one is the page a customer sees.

Appearance is chosen from fixed sets, never typed — the same rule `bio_link`
states, for the same reason. Nothing the owner enters becomes CSS, so a
curated palette can guarantee the menu stays legible on a screen that is not
the one it was built on.
"""

import json
import re

from bio_link import SOCIAL_PLATFORMS, validate_url
from common import BASE_IMAGE_CONTENT_TYPES, d1_rows, next_position, random_object_key, storage_key_to_url, urlsafe_token, utc_timestamp, validate_choice, validate_image_suffix as _validate_image_suffix, validate_text


MENU_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,60}$")

BACKGROUNDS = ("transparent", "solid", "image")
# Five surfaces chosen to sit under either text tone. Adding a sixth is a
# design decision made once here, not a colour picker handed to whoever is
# editing at the time.
COLOURS = ("cream", "sand", "clay", "forest", "ink")
TEXT_TONES = ("dark", "light")
SIZES = ("small", "medium", "large")

TARGET_KINDS = ("page", "category", "url")

MAX_LABEL = 30
MAX_COPYRIGHT = 200
# The sentence under the mark in the footer's brand column. Plain text with a
# limit, like every other chrome field — long enough for what the shop is,
# short enough that it cannot become the page.
MAX_BLURB = 200
MAX_CTA_LABEL = 20
MAX_FOOTER_COLUMNS = 4
MAX_FOOTER_LINKS = 10
MAX_FOOTER_SOCIALS = 10
MAX_MENU_ITEMS = 60
MAX_MENU_DEPTH = 3

IMAGE_PREFIX = "_site"
IMAGE_URL_PREFIX = "/site-assets"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_BYTES = 3 * 1024 * 1024


class ChromeError(Exception):
    """The settings or menu item as submitted cannot be stored."""


def choice(value, allowed: tuple[str, ...], label: str) -> str:
    return str(validate_choice(value, allowed, label, error_cls=ChromeError))


def text(value, limit: int, label: str, *, required: bool = False) -> str:
    return validate_text(value, limit, label, required=required, error_cls=ChromeError)


def validate_menu_id(menu_id: str) -> str:
    if not MENU_ID_PATTERN.fullmatch(menu_id):
        raise ChromeError("Invalid menu item id")
    return menu_id


def image_key(suffix: str) -> str:
    return random_object_key(IMAGE_PREFIX, suffix)


def image_path(key: str | None) -> str | None:
    return storage_key_to_url(key, IMAGE_PREFIX, IMAGE_URL_PREFIX)


def validate_image_suffix(file_name: str) -> str:
    try:
        return _validate_image_suffix(file_name, IMAGE_SUFFIXES, "背景圖必須是 jpg、png 或 webp")
    except ValueError as error:
        raise ChromeError(str(error)) from error


# --- footer structure ----------------------------------------------------


def validate_footer_columns(raw) -> list[dict]:
    """Link columns, validated on the way in and again on the way out.

    Stored as JSON, so a row written by an older version has to be checked
    when read as well — otherwise one stale settings row takes the footer off
    every page at once.
    """

    if not isinstance(raw, list):
        raise ChromeError("頁尾欄位必須是列表")
    if len(raw) > MAX_FOOTER_COLUMNS:
        raise ChromeError(f"頁尾最多 {MAX_FOOTER_COLUMNS} 欄")

    columns = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ChromeError("頁尾欄位格式不正確")
        links = entry.get("links")
        if not isinstance(links, list):
            raise ChromeError("頁尾欄位的連結必須是列表")
        if len(links) > MAX_FOOTER_LINKS:
            raise ChromeError(f"每欄最多 {MAX_FOOTER_LINKS} 個連結")
        columns.append(
            {
                "title": text(entry.get("title"), MAX_LABEL, "欄位標題"),
                "links": [
                    {
                        "label": text(link.get("label"), MAX_LABEL, "連結文字", required=True),
                        "url": validate_url(str(link.get("url") or "")),
                    }
                    for link in links
                    if isinstance(link, dict)
                ],
            }
        )
    return columns


def validate_footer_socials(raw) -> list[dict]:
    if not isinstance(raw, list):
        raise ChromeError("社群連結必須是列表")
    if len(raw) > MAX_FOOTER_SOCIALS:
        raise ChromeError(f"最多 {MAX_FOOTER_SOCIALS} 個社群連結")

    socials = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ChromeError("社群連結格式不正確")
        platform = str(entry.get("platform") or "")
        if platform not in SOCIAL_PLATFORMS:
            raise ChromeError(f"未知的社群平台：{platform}")
        socials.append({"platform": platform, "url": validate_url(str(entry.get("url") or ""))})
    return socials


def _read_json_list(raw: str, validator) -> list[dict]:
    """Parse a stored JSON list, falling back to empty when it no longer fits.

    Empty is the right failure: a footer missing its links still lets every
    page render, where raising would take the whole site down over one column.
    """

    try:
        return validator(json.loads(raw))
    except (ChromeError, ValueError, TypeError):
        return []


# --- settings ------------------------------------------------------------


DEFAULTS = {
    "headerBackground": "solid",
    "headerColour": "cream",
    "headerImagePath": None,
    "headerHeight": "medium",
    "headerText": "dark",
    "headerLogoSize": "medium",
    "headerSticky": True,
    "headerShowCart": True,
    "headerShowLogin": True,
    "headerCtaLabel": "",
    "headerCtaUrl": "",
    "footerColour": "ink",
    "footerText": "light",
    "footerBlurb": "",
    "footerCopyright": "",
    "footerColumns": [],
    "footerSocials": [],
}


def settings_row(row: dict) -> dict:
    return {
        "headerBackground": row["header_background"],
        "headerColour": row["header_colour"],
        "headerImagePath": image_path(row["header_image_key"]),
        "headerHeight": row["header_height"],
        "headerText": row["header_text"],
        "headerLogoSize": row["header_logo_size"],
        "headerSticky": bool(row["header_sticky"]),
        "headerShowCart": bool(row["header_show_cart"]),
        "headerShowLogin": bool(row["header_show_login"]),
        "headerCtaLabel": row["header_cta_label"],
        "headerCtaUrl": row["header_cta_url"],
        "footerColour": row["footer_colour"],
        "footerText": row["footer_text"],
        # Read defensively: both Workers read this table and only the admin one
        # applies migrations, so the public deployment can see a row from
        # before this column existed. An empty blurb is a footer without a
        # sentence; a KeyError is a site without a footer.
        "footerBlurb": row["footer_blurb"] if "footer_blurb" in row else "",
        "footerCopyright": row["footer_copyright"],
        "footerColumns": _read_json_list(row["footer_columns"], validate_footer_columns),
        "footerSocials": _read_json_list(row["footer_socials"], validate_footer_socials),
    }


async def get_settings(env) -> dict:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM site_settings WHERE id = 1"))
    return settings_row(rows[0]) if rows else dict(DEFAULTS)


async def header_image_key(env) -> str | None:
    rows = await d1_rows(env.DB.prepare("SELECT header_image_key FROM site_settings WHERE id = 1"))
    return rows[0]["header_image_key"] if rows else None


def validate_settings(body: dict) -> dict:
    """Every field, checked against its fixed set. Nothing here becomes CSS."""

    cta_url = str(body.get("headerCtaUrl") or "")
    return {
        "header_background": choice(body.get("headerBackground"), BACKGROUNDS, "頁首背景"),
        "header_colour": choice(body.get("headerColour"), COLOURS, "頁首底色"),
        "header_height": choice(body.get("headerHeight"), SIZES, "頁首高度"),
        "header_text": choice(body.get("headerText"), TEXT_TONES, "頁首文字色"),
        "header_logo_size": choice(body.get("headerLogoSize"), SIZES, "logo 大小"),
        "header_sticky": 1 if body.get("headerSticky", True) else 0,
        "header_show_cart": 1 if body.get("headerShowCart", True) else 0,
        "header_show_login": 1 if body.get("headerShowLogin", True) else 0,
        "header_cta_label": text(body.get("headerCtaLabel"), MAX_CTA_LABEL, "按鈕文字"),
        "header_cta_url": validate_url(cta_url) if cta_url else "",
        "footer_colour": choice(body.get("footerColour"), COLOURS, "頁尾底色"),
        "footer_text": choice(body.get("footerText"), TEXT_TONES, "頁尾文字色"),
        "footer_blurb": text(body.get("footerBlurb"), MAX_BLURB, "頁尾介紹"),
        "footer_copyright": text(body.get("footerCopyright"), MAX_COPYRIGHT, "版權文字"),
        "footer_columns": json.dumps(validate_footer_columns(body.get("footerColumns") or []), ensure_ascii=False),
        "footer_socials": json.dumps(validate_footer_socials(body.get("footerSocials") or []), ensure_ascii=False),
    }


_SETTINGS_COLUMNS = frozenset({
    "header_background", "header_colour", "header_height", "header_text",
    "header_logo_size", "header_sticky", "header_show_cart", "header_show_login",
    "header_cta_label", "header_cta_url",
    "footer_colour", "footer_text", "footer_blurb", "footer_copyright",
    "footer_columns", "footer_socials",
})


async def save_settings(env, fields: dict) -> None:
    bad = set(fields) - _SETTINGS_COLUMNS
    if bad:
        raise ValueError(f"Unknown settings column: {', '.join(sorted(bad))}")
    columns = ", ".join(f"{name} = ?{index + 2}" for index, name in enumerate(fields))
    now = utc_timestamp()
    await env.DB.prepare(
        f"INSERT INTO site_settings (id, {', '.join(fields)}, updated_at)"
        f" VALUES (1, {', '.join(f'?{index + 2}' for index in range(len(fields)))}, ?1)"
        f" ON CONFLICT(id) DO UPDATE SET {columns}, updated_at = ?1"
    ).bind(now, *fields.values()).run()


async def set_header_image(env, key: str | None) -> None:
    now = utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO site_settings (id, header_image_key, updated_at) VALUES (1, ?1, ?2)"
        " ON CONFLICT(id) DO UPDATE SET header_image_key = ?1, updated_at = ?2"
    ).bind(key, now).run()


# --- menu ----------------------------------------------------------------


def menu_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "parentId": row["parent_id"],
        "label": row["label"],
        "targetKind": row["target_kind"],
        "target": row["target"],
        "position": int(row["position"]),
    }


async def list_menu(env) -> list[dict]:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM menu_items ORDER BY position, id"))
    return [menu_row(row) for row in rows]


async def get_menu_item(env, menu_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM menu_items WHERE id = ?1").bind(menu_id))
    return menu_row(rows[0]) if rows else None


async def count_menu(env) -> int:
    rows = await d1_rows(env.DB.prepare("SELECT COUNT(*) AS total FROM menu_items"))
    return int(rows[0]["total"]) if rows else 0


def depth_of(items: list[dict], parent_id: str | None) -> int:
    """How deep an item under `parent_id` would sit. Top level is 1."""

    by_id = {item["id"]: item for item in items}
    depth = 1
    seen = set()
    while parent_id:
        # A cycle cannot be created through the API, but a hand-edited row
        # could; counting forever is a worse outcome than refusing the move.
        if parent_id in seen:
            raise ChromeError("選單結構有循環")
        seen.add(parent_id)
        parent = by_id.get(parent_id)
        if parent is None:
            raise ChromeError("找不到上層項目")
        depth += 1
        parent_id = parent["parentId"]
    return depth


def validate_menu_fields(body: dict) -> dict:
    kind = choice(body.get("targetKind"), TARGET_KINDS, "連結類型")
    target = str(body.get("target") or "").strip()
    if not target:
        raise ChromeError("請選擇這個項目要連到哪裡")
    if kind == "url":
        target = validate_url(target)
    return {
        "label": text(body.get("label"), MAX_LABEL, "選單文字", required=True),
        "target_kind": kind,
        "target": target,
    }


async def create_menu_item(env, *, parent_id: str | None, label: str, target_kind: str, target: str) -> str:
    position = await next_position(env, "menu_items", "parent_id IS ?1", (parent_id,))
    menu_id = urlsafe_token(18)
    await env.DB.prepare(
        "INSERT INTO menu_items (id, parent_id, label, target_kind, target, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(menu_id, parent_id, label, target_kind, target, position).run()
    return menu_id


async def update_menu_item(env, menu_id: str, *, label: str, target_kind: str, target: str) -> bool:
    if await get_menu_item(env, menu_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE menu_items SET label = ?2, target_kind = ?3, target = ?4 WHERE id = ?1"
    ).bind(menu_id, label, target_kind, target).run()
    return True


async def delete_menu_item(env, menu_id: str) -> bool:
    """Remove an item and everything nested under it.

    Leaving orphans would hide them from the editor while the public menu
    stopped showing them too — invisible in both places is the one outcome
    worth avoiding.
    """

    if await get_menu_item(env, menu_id) is None:
        return False
    items = await list_menu(env)
    doomed = {menu_id}
    changed = True
    while changed:
        changed = False
        for item in items:
            if item["parentId"] in doomed and item["id"] not in doomed:
                doomed.add(item["id"])
                changed = True
    for victim in doomed:
        await env.DB.prepare("DELETE FROM menu_items WHERE id = ?1").bind(victim).run()
    return True


async def reorder_menu(env, ordered: list[dict]) -> None:
    """Apply a whole new arrangement: parents and positions together.

    Moving an item between levels and reordering it are the same gesture in
    the editor, so they are one request — two would let a drag land half done.
    """

    # `reorder_rows` deliberately handles a single id/position update. Menu
    # drags also change `parent_id`; keep those two columns in the same write
    # so an item can never be left reordered under its former parent.
    for index, entry in enumerate(ordered):
        await env.DB.prepare("UPDATE menu_items SET parent_id = ?2, position = ?3 WHERE id = ?1").bind(
            entry["id"], entry["parentId"], index
        ).run()
