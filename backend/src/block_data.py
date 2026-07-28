"""What a block needs to be drawn, fetched once for a whole page.

A block's config holds ids: a media id, a product slug, a category filter.
Turning those into pictures and prices needs the database, and doing it inside
`pages.py` would drag the shop and the media library into a module that only
knows about pages.

So the config stays exactly as it was stored — the editor sends it straight
back — and everything resolved from it arrives beside it as `data`. That split
is why a deleted image loses one slide instead of breaking the page: the id is
still in the config to be repaired, and the render simply has one fewer picture.
"""

import categories
import media
import shop


async def hydrate(env, blocks: list[dict]) -> list[dict]:
    """Attach `data` to every block on a page, using as few queries as it can.

    Media ids are collected across all blocks and looked up once. Products are
    per block, because a block naming five products and a block naming a
    category do not share an answer.
    """

    wanted: list[str] = []
    for block in blocks:
        wanted.extend(_media_ids(block))
    library = await media.resolve(env, wanted) if wanted else {}

    for block in blocks:
        block["data"] = await _data_for(env, block, library)
    return blocks


def _media_ids(block: dict) -> list[str]:
    config = block.get("config") or {}
    if block["type"] == "carousel":
        return [str(slide.get("mediaId") or "") for slide in config.get("slides") or []]
    if block["type"] == "album":
        return [str(media_id) for media_id in config.get("mediaIds") or []]
    if block["type"] == "about":
        return [str(config.get("mediaId") or "")]
    return []


def _picture(library: dict, media_id: str) -> dict | None:
    item = library.get(media_id)
    if item is None:
        return None
    return {"id": item["id"], "path": item["path"], "alt": item["alt"]}


async def _data_for(env, block: dict, library: dict) -> dict:
    config = block.get("config") or {}
    kind = block["type"]

    if kind == "carousel":
        slides = []
        for slide in config.get("slides") or []:
            picture = _picture(library, str(slide.get("mediaId") or ""))
            # A slide whose image is gone is dropped rather than drawn empty.
            if picture is None:
                continue
            slides.append(
                {
                    "image": picture,
                    # The slide's own caption wins over the library's alt text:
                    # the same photograph can mean different things on two pages.
                    "caption": slide.get("caption") or "",
                    "href": slide.get("href") or "",
                }
            )
        return {"slides": slides}

    if kind == "album":
        pictures = [_picture(library, str(media_id)) for media_id in config.get("mediaIds") or []]
        return {"images": [picture for picture in pictures if picture is not None]}

    if kind == "about":
        return {"image": _picture(library, str(config.get("mediaId") or ""))}

    if kind == "shop":
        return await _shop_data(env, config)

    return {}


async def _shop_data(env, config: dict) -> dict:
    """The cards a shop block shows.

    Named products keep the owner's order — that is the point of naming them.
    A category block follows the shop's own order, because the alternative is
    a second place to arrange the same products.
    """

    limit = int(config.get("limit") or 24)
    if config.get("source") == "category":
        products = await _products_by_filter(env, str(config.get("filter") or ""))
    else:
        products = await _products_by_slug(env, [str(slug) for slug in config.get("slugs") or []])

    cards = []
    for product in products[:limit]:
        cards.append(
            shop.public_summary(
                product,
                await shop.list_variants(env, product["id"]),
                await shop.list_images(env, product["id"]),
            )
        )
    return {"products": cards}


async def _products_by_slug(env, slugs: list[str]) -> list[dict]:
    found = []
    for slug in slugs:
        product = await shop.get_product_by_slug(env, slug)
        # A product that was archived or deleted since is left out. The block
        # keeps naming it, so putting it back on sale puts it back on the page.
        if product is not None and product["status"] == "active":
            found.append(product)
    return found


async def _products_by_filter(env, raw: str) -> list[dict]:
    if not raw:
        return []
    try:
        slugs, mode = categories.parse_filter(raw)
    except ValueError:
        return []
    matched = await categories.by_slugs(env, slugs)
    # A filter naming a category that no longer exists would otherwise widen
    # to whatever is left, which is not what the owner asked for.
    if len(matched) != len(slugs):
        return []
    return await categories.products_in(env, [category["id"] for category in matched], mode)
