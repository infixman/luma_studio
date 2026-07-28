"""Product categories, which are flat and many-to-many — so, tags.

There is no hierarchy. The storefront's menu nests three deep, but that
nesting is arranged by hand in the menu editor and does not grow out of this
table; the two are independent on purpose, so the menu can group things any
way it likes without the catalogue having to agree.

A category page can name several categories at once. A comma between slugs
means "any of these", a plus means "all of these", and the two cannot be
mixed — see `parse_filter`.
"""

import shop
from common import d1_rows, urlsafe_token, utc_timestamp


MAX_TITLE = 40
MAX_DESCRIPTION = 500

# A URL naming two hundred slugs is one large query. The rate limiter stops a
# sustained attempt; a cap is cheaper, and states what the shape is meant to be.
MAX_FILTER = 5

ANY_OF, ALL_OF = "any", "all"
SEPARATORS = {",": ANY_OF, "+": ALL_OF}


def validate_id(category_id: str) -> str:
    if not shop.PRODUCT_ID_PATTERN.fullmatch(category_id):
        raise ValueError("Invalid category id")
    return category_id


def parse_filter(raw: str) -> tuple[list[str], str]:
    """Read `a`, `a,b` or `a+b` into slugs and a mode.

    Mixing the separators is refused rather than given a precedence rule.
    The moment `a,b+c` has a meaning, this is a query language, and the back
    office has to grow a way for someone to express it.
    """

    raw = raw.strip()
    if not raw:
        raise ValueError("No category given")

    present = [character for character in SEPARATORS if character in raw]
    if len(present) > 1:
        raise ValueError("A category filter uses either , or + — not both")

    separator = present[0] if present else ","
    slugs = [shop.validate_slug(part) for part in raw.split(separator) if part.strip()]
    if not slugs:
        raise ValueError("No category given")
    if len(slugs) > MAX_FILTER:
        raise ValueError(f"A category filter can name at most {MAX_FILTER} categories")
    # Duplicates would inflate the AND count into never matching, and mean
    # nothing at all for OR.
    return list(dict.fromkeys(slugs)), SEPARATORS[separator]


def row(record: dict) -> dict:
    return {
        "id": record["id"],
        "slug": record["slug"],
        "title": record["title"],
        "description": record["description"],
        "position": int(record["position"]),
    }


def _placeholders(start: int, count: int) -> str:
    return ", ".join(f"?{start + index}" for index in range(count))


def filter_title(categories: list[dict], mode: str) -> str:
    """What to call a page that names more than one category.

    A single category has its own title. A combination has none, so it is
    built from the parts rather than left blank.
    """

    if len(categories) == 1:
        return categories[0]["title"]
    joiner = " ＋ " if mode == ALL_OF else "、"
    return joiner.join(category["title"] for category in categories)


# --- reading -------------------------------------------------------------


async def list_all(env) -> list[dict]:
    return [
        row(record)
        for record in await d1_rows(env.DB.prepare("SELECT * FROM product_categories ORDER BY position, title, id"))
    ]


async def counts(env) -> dict:
    """How many *active* products each category holds.

    Drafts are excluded for the same reason they are excluded from the page
    itself: a count that includes them promises a visitor something they will
    not find when they click.
    """

    records = await d1_rows(
        env.DB.prepare(
            "SELECT l.category_id AS category_id, COUNT(*) AS total"
            " FROM product_category_links l JOIN products p ON p.id = l.product_id"
            " WHERE p.status = 'active' GROUP BY l.category_id"
        )
    )
    return {record["category_id"]: int(record["total"]) for record in records}


async def get(env, category_id: str) -> dict | None:
    records = await d1_rows(env.DB.prepare("SELECT * FROM product_categories WHERE id = ?1").bind(category_id))
    return row(records[0]) if records else None


async def by_slugs(env, slugs: list[str]) -> list[dict]:
    """The named categories, in the order they were named.

    Order matters: the page title reads "A、B" and should match the URL that
    produced it.
    """

    if not slugs:
        return []
    query = f"SELECT * FROM product_categories WHERE slug IN ({_placeholders(1, len(slugs))})"
    found = {record["slug"]: row(record) for record in await d1_rows(env.DB.prepare(query).bind(*slugs))}
    return [found[slug] for slug in slugs if slug in found]


async def slug_taken(env, slug: str, *, excluding: str | None = None) -> bool:
    records = await d1_rows(
        env.DB.prepare("SELECT id FROM product_categories WHERE slug = ?1 AND id != ?2").bind(slug, excluding or "")
    )
    return bool(records)


async def of_product(env, product_id: str) -> list[dict]:
    records = await d1_rows(
        env.DB.prepare(
            "SELECT c.* FROM product_categories c"
            " JOIN product_category_links l ON l.category_id = c.id"
            " WHERE l.product_id = ?1 ORDER BY c.position, c.title, c.id"
        ).bind(product_id)
    )
    return [row(record) for record in records]


async def products_in(env, category_ids: list[str], mode: str) -> list[dict]:
    """Active products matching a set of categories, under `any` or `all`.

    Shared with the shop block on a custom page, so the filter a visitor
    reaches through a URL and the filter an owner configures in the back
    office cannot end up disagreeing about what "all of these" means.
    """

    if not category_ids:
        return []

    placeholders = _placeholders(1, len(category_ids))
    if mode == ALL_OF:
        # COUNT(DISTINCT ...) rather than COUNT(*): the primary key stops a
        # duplicate link today, and a count that is only correct because of
        # that starts passing the wrong products the day the key changes.
        query = (
            "SELECT p.* FROM products p JOIN product_category_links l ON l.product_id = p.id"
            f" WHERE p.status = 'active' AND l.category_id IN ({placeholders})"
            " GROUP BY p.id"
            f" HAVING COUNT(DISTINCT l.category_id) = ?{len(category_ids) + 1}"
            " ORDER BY p.position, p.created_at, p.id"
        )
        statement = env.DB.prepare(query).bind(*category_ids, len(category_ids))
    else:
        query = (
            "SELECT DISTINCT p.* FROM products p JOIN product_category_links l ON l.product_id = p.id"
            f" WHERE p.status = 'active' AND l.category_id IN ({placeholders})"
            " ORDER BY p.position, p.created_at, p.id"
        )
        statement = env.DB.prepare(query).bind(*category_ids)

    return [shop.product_row(record) for record in await d1_rows(statement)]


# --- writing -------------------------------------------------------------


async def create(env, *, slug: str, title: str, description: str) -> str:
    records = await d1_rows(env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM product_categories"))
    position = (int(records[0]["last"]) if records else -1) + 1
    category_id, now = urlsafe_token(18), utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO product_categories (id, slug, title, description, position, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"
    ).bind(category_id, slug, title, description, position, now).run()
    return category_id


async def update(env, category_id: str, *, slug: str, title: str, description: str) -> bool:
    if await get(env, category_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE product_categories SET slug = ?2, title = ?3, description = ?4, updated_at = ?5 WHERE id = ?1"
    ).bind(category_id, slug, title, description, utc_timestamp()).run()
    return True


async def remove(env, category_id: str) -> bool:
    """Delete a category and its links. Products are left alone.

    A category is a label stuck on a product. Peeling the label off is not
    supposed to throw the product away.
    """

    if await get(env, category_id) is None:
        return False
    await env.DB.prepare("DELETE FROM product_category_links WHERE category_id = ?1").bind(category_id).run()
    await env.DB.prepare("DELETE FROM product_categories WHERE id = ?1").bind(category_id).run()
    return True


async def reorder(env, ordered_ids: list[str]) -> None:
    now = utc_timestamp()
    for index, category_id in enumerate(ordered_ids):
        await env.DB.prepare("UPDATE product_categories SET position = ?2, updated_at = ?3 WHERE id = ?1").bind(
            category_id, index, now
        ).run()


async def set_for_product(env, product_id: str, category_ids: list[str]) -> None:
    """Replace a product's categories with exactly this set."""

    await env.DB.prepare("DELETE FROM product_category_links WHERE product_id = ?1").bind(product_id).run()
    for category_id in dict.fromkeys(category_ids):
        await env.DB.prepare(
            "INSERT OR IGNORE INTO product_category_links (product_id, category_id) VALUES (?1, ?2)"
        ).bind(product_id, category_id).run()
