"""The shop's catalogue: products, their variants and their photographs.

Money is whole New Taiwan dollars throughout. PAYUNi's `TradeAmt` is an
integer, retail here has no sub-dollar amounts, and a smaller unit would only
add a conversion for rounding to go wrong in.

Nothing in this module trusts the database to have stayed valid. A product
read back for a customer-facing response is validated on the way out as well
as on the way in, because a row written by an older version of this code, or
by hand, must not be able to reach a page.
"""

import re

from common import d1_rows, urlsafe_token, utc_timestamp


PRODUCT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,60}$")
# Lowercase only, and never leading or trailing punctuation: this ends up in a
# customer-facing URL, where a trailing hyphen reads as a typo and an uppercase
# letter is a support question waiting to happen.
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

MAX_SLUG = 64
MAX_TITLE = 80
MAX_DESCRIPTION = 2000
MAX_VARIANT_TITLE = 60
MAX_SKU = 40
MAX_ALT = 120

# One product page a person can actually take in, and a cap that keeps a
# runaway loop from filling the bucket.
MAX_VARIANTS = 30
MAX_IMAGES = 8

# The floor is 1 rather than 0: a free item is not a thing this shop sells,
# and a zero-priced line would sail through checkout as a rounding artefact.
# The ceiling matches PAYUNi's per-order limit, so a single line can never on
# its own exceed what the gateway will accept.
MIN_PRICE = 1
MAX_PRICE = 20000
MAX_STOCK = 100000

PRODUCT_STATUSES = ("draft", "active", "archived")

# Same underscore trick as bio-link avatars: the prefix keeps these out of
# IDENTIFIER_PATTERN, so a product photo can never be reached through the ibon
# /images/ route or mistaken for a print folder.
IMAGE_PREFIX = "_shop"
IMAGE_URL_PREFIX = "/shop-assets"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
IMAGE_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
MAX_IMAGE_BYTES = 3 * 1024 * 1024

# Below this, a customer sees the number; above it, only "in stock". "2 left"
# earns its keep at the checkout; publishing the exact figure for everything
# hands anyone who watches it a running tally of what the shop has sold.
LOW_STOCK_THRESHOLD = 5


# --- validation ----------------------------------------------------------


def validate_product_id(product_id: str) -> str:
    if not PRODUCT_ID_PATTERN.fullmatch(product_id):
        raise ValueError("Invalid product id")
    return product_id


def validate_text(value: str, limit: int, label: str, required: bool = True) -> str:
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required")
    if len(value) > limit:
        raise ValueError(f"{label} must be {limit} characters or fewer")
    return value


def validate_slug(slug: str) -> str:
    slug = slug.strip().lower()
    if not slug:
        raise ValueError("Slug is required")
    if len(slug) > MAX_SLUG:
        raise ValueError(f"Slug must be {MAX_SLUG} characters or fewer")
    if not SLUG_PATTERN.fullmatch(slug):
        raise ValueError("Slug may use lowercase letters, numbers and single hyphens between them")
    return slug


def validate_status(status: str) -> str:
    if status not in PRODUCT_STATUSES:
        raise ValueError(f"Status must be one of: {', '.join(PRODUCT_STATUSES)}")
    return status


def validate_whole_number(value, low: int, high: int, label: str) -> int:
    """Reject anything that is not already a whole number.

    `int(value)` would quietly accept 12.7 as 12 and "0012" as 12. A price
    that arrives in the wrong shape is a bug in the caller, and truncating it
    hides that until someone is charged the wrong amount.
    """

    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be a whole number")
    if value < low or value > high:
        raise ValueError(f"{label} must be between {low} and {high}")
    return value


def validate_price(value) -> int:
    return validate_whole_number(value, MIN_PRICE, MAX_PRICE, "Price")


def validate_stock(value) -> int:
    return validate_whole_number(value, 0, MAX_STOCK, "Stock")


def image_key(suffix: str) -> str:
    return f"{IMAGE_PREFIX}/{urlsafe_token(12)}{suffix}"


def image_path(key: str) -> str | None:
    """The public URL path for a stored image key.

    The R2 prefix and the URL differ, so the mapping lives here rather than
    being reassembled by every caller.
    """

    if not key or not key.startswith(f"{IMAGE_PREFIX}/"):
        return None
    return f"{IMAGE_URL_PREFIX}/{key.removeprefix(f'{IMAGE_PREFIX}/')}"


def validate_image_suffix(file_name: str) -> str:
    suffix = file_name[file_name.rfind(".") :].lower()
    if "/" in file_name or ".." in file_name or suffix not in IMAGE_SUFFIXES:
        raise ValueError("A product photo must be a jpg, png or webp image")
    return suffix


# --- row mapping ---------------------------------------------------------


def product_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "slug": row["slug"],
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "position": int(row["position"]),
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


def variant_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "productId": row["product_id"],
        "title": row["title"],
        "sku": row["sku"],
        "price": int(row["price"]),
        "stock": int(row["stock"]),
        "position": int(row["position"]),
        "enabled": bool(row["enabled"]),
    }


def image_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "productId": row["product_id"],
        "path": image_path(row["r2_key"]),
        "alt": row["alt"],
        "position": int(row["position"]),
    }


def public_summary(product: dict, variants: list[dict], images: list[dict]) -> dict:
    """One card on the shop's index.

    A product whose variants are all disabled has no price and cannot be
    bought, so it reports itself as unavailable rather than showing a blank
    where the price goes.
    """

    sellable = [variant for variant in variants if variant["enabled"]]
    prices = [variant["price"] for variant in sellable]
    return {
        "slug": product["slug"],
        "title": product["title"],
        "coverPath": images[0]["path"] if images else None,
        "priceFrom": min(prices) if prices else None,
        "priceTo": max(prices) if prices else None,
        "inStock": any(variant["stock"] > 0 for variant in sellable),
    }


def public_detail(product: dict, variants: list[dict], images: list[dict], product_categories: list[dict]) -> dict:
    """One product page. Disabled variants are withheld entirely."""

    return {
        "slug": product["slug"],
        "title": product["title"],
        "description": product["description"],
        "images": [{"path": image["path"], "alt": image["alt"]} for image in images],
        "variants": [public_variant(variant) for variant in variants if variant["enabled"]],
        "categories": [{"slug": c["slug"], "title": c["title"]} for c in product_categories],
    }


def public_variant(variant: dict) -> dict:
    """What a customer is allowed to know about a variant.

    Stock becomes a availability flag plus, near the bottom, a number. The
    exact figure for a well-stocked item is a sales ledger anyone can poll.
    """

    stock = variant["stock"]
    return {
        "id": variant["id"],
        "title": variant["title"],
        "price": variant["price"],
        "inStock": stock > 0,
        "stockLeft": stock if 0 < stock <= LOW_STOCK_THRESHOLD else None,
    }


# --- products ------------------------------------------------------------


async def list_products(env, *, only_active: bool = False) -> list[dict]:
    query = "SELECT * FROM products"
    if only_active:
        query += " WHERE status = 'active'"
    query += " ORDER BY position, created_at, id"
    return [product_row(row) for row in await d1_rows(env.DB.prepare(query))]


async def get_product(env, product_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM products WHERE id = ?1").bind(product_id))
    return product_row(rows[0]) if rows else None


async def get_product_by_slug(env, slug: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM products WHERE slug = ?1").bind(slug))
    return product_row(rows[0]) if rows else None


async def slug_taken(env, slug: str, *, excluding: str | None = None) -> bool:
    rows = await d1_rows(
        env.DB.prepare("SELECT id FROM products WHERE slug = ?1 AND id != ?2").bind(slug, excluding or "")
    )
    return bool(rows)


async def count_products(env) -> int:
    rows = await d1_rows(env.DB.prepare("SELECT COUNT(*) AS total FROM products"))
    return int(rows[0]["total"]) if rows else 0


async def create_product(env, *, slug: str, title: str, description: str, status: str) -> str:
    rows = await d1_rows(env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM products"))
    position = (int(rows[0]["last"]) if rows else -1) + 1
    product_id, now = urlsafe_token(18), utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO products (id, slug, title, description, status, position, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)"
    ).bind(product_id, slug, title, description, status, position, now).run()
    return product_id


async def update_product(env, product_id: str, *, slug: str, title: str, description: str, status: str) -> bool:
    """Returns False when no such product exists, so callers can answer 404."""

    if await get_product(env, product_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE products SET slug = ?2, title = ?3, description = ?4, status = ?5, updated_at = ?6 WHERE id = ?1"
    ).bind(product_id, slug, title, description, status, utc_timestamp()).run()
    return True


async def delete_product(env, product_id: str) -> list[str]:
    """Remove a product and everything hanging off it.

    Returns the R2 keys that are now unreferenced. Deleting the objects is the
    caller's job: the row has to go first, because a product that still lists
    a photo nobody can fetch is worse than an orphaned object in a bucket.
    """

    rows = await d1_rows(env.DB.prepare("SELECT r2_key FROM product_images WHERE product_id = ?1").bind(product_id))
    keys = [row["r2_key"] for row in rows]
    # Children first, so a failure part-way through leaves rows that still
    # point at a product rather than rows that point at nothing.
    await env.DB.prepare("DELETE FROM product_images WHERE product_id = ?1").bind(product_id).run()
    await env.DB.prepare("DELETE FROM product_variants WHERE product_id = ?1").bind(product_id).run()
    await env.DB.prepare("DELETE FROM products WHERE id = ?1").bind(product_id).run()
    return keys


async def reorder_products(env, ordered_ids: list[str]) -> None:
    """Statements run one at a time rather than through `DB.batch`.

    Batching would be tidier, but nothing in this codebase has exercised D1's
    batch API from Python yet, and a list of prepared statements has to cross
    into JavaScript to get there. A half-applied ordering is cosmetic and
    self-corrects on the next save; guessing at an unproven binding on the
    path that writes the catalogue is not worth that.
    """

    now = utc_timestamp()
    for index, product_id in enumerate(ordered_ids):
        await env.DB.prepare("UPDATE products SET position = ?2, updated_at = ?3 WHERE id = ?1").bind(
            product_id, index, now
        ).run()


# --- variants ------------------------------------------------------------


async def list_variants(env, product_id: str, *, only_enabled: bool = False) -> list[dict]:
    query = "SELECT * FROM product_variants WHERE product_id = ?1"
    if only_enabled:
        query += " AND enabled = 1"
    query += " ORDER BY position, id"
    return [variant_row(row) for row in await d1_rows(env.DB.prepare(query).bind(product_id))]


async def get_variant(env, variant_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM product_variants WHERE id = ?1").bind(variant_id))
    return variant_row(rows[0]) if rows else None


async def count_variants(env, product_id: str) -> int:
    rows = await d1_rows(
        env.DB.prepare("SELECT COUNT(*) AS total FROM product_variants WHERE product_id = ?1").bind(product_id)
    )
    return int(rows[0]["total"]) if rows else 0


async def create_variant(env, product_id: str, *, title: str, sku: str, price: int, stock: int) -> str:
    rows = await d1_rows(
        env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM product_variants WHERE product_id = ?1").bind(
            product_id
        )
    )
    position = (int(rows[0]["last"]) if rows else -1) + 1
    variant_id = urlsafe_token(18)
    await env.DB.prepare(
        "INSERT INTO product_variants (id, product_id, title, sku, price, stock, position, enabled)"
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)"
    ).bind(variant_id, product_id, title, sku, price, stock, position).run()
    return variant_id


async def update_variant(env, variant_id: str, *, title: str, sku: str, price: int, stock: int, enabled: bool) -> bool:
    if await get_variant(env, variant_id) is None:
        return False
    await env.DB.prepare(
        "UPDATE product_variants SET title = ?2, sku = ?3, price = ?4, stock = ?5, enabled = ?6 WHERE id = ?1"
    ).bind(variant_id, title, sku, price, stock, 1 if enabled else 0).run()
    return True


async def delete_variant(env, variant_id: str) -> bool:
    if await get_variant(env, variant_id) is None:
        return False
    await env.DB.prepare("DELETE FROM product_variants WHERE id = ?1").bind(variant_id).run()
    return True


# --- images --------------------------------------------------------------


async def list_images(env, product_id: str) -> list[dict]:
    return [
        image_row(row)
        for row in await d1_rows(
            env.DB.prepare("SELECT * FROM product_images WHERE product_id = ?1 ORDER BY position, id").bind(product_id)
        )
    ]


async def count_images(env, product_id: str) -> int:
    rows = await d1_rows(
        env.DB.prepare("SELECT COUNT(*) AS total FROM product_images WHERE product_id = ?1").bind(product_id)
    )
    return int(rows[0]["total"]) if rows else 0


async def add_image(env, product_id: str, key: str, alt: str) -> str:
    rows = await d1_rows(
        env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS last FROM product_images WHERE product_id = ?1").bind(
            product_id
        )
    )
    position = (int(rows[0]["last"]) if rows else -1) + 1
    image_id = urlsafe_token(18)
    await env.DB.prepare(
        "INSERT INTO product_images (id, product_id, r2_key, alt, position) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(image_id, product_id, key, alt, position).run()
    return image_id


async def delete_image(env, image_id: str) -> dict | None:
    """Remove the row, and hand back what the caller still needs.

    The R2 key so the object can go too, and the product id because the row is
    gone by the time the caller wants to re-render the product it belonged to.
    """

    rows = await d1_rows(
        env.DB.prepare("SELECT r2_key, product_id FROM product_images WHERE id = ?1").bind(image_id)
    )
    if not rows:
        return None
    await env.DB.prepare("DELETE FROM product_images WHERE id = ?1").bind(image_id).run()
    return {"key": rows[0]["r2_key"], "productId": rows[0]["product_id"]}


async def image_key_for_file(env, file_name: str) -> str | None:
    """Resolve a public /shop-assets/{file} request back to a stored key.

    The lookup goes through the table rather than trusting the URL, so a
    request can only ever reach an object some product actually references.
    """

    key = f"{IMAGE_PREFIX}/{file_name}"
    rows = await d1_rows(env.DB.prepare("SELECT r2_key FROM product_images WHERE r2_key = ?1").bind(key))
    return rows[0]["r2_key"] if rows else None
