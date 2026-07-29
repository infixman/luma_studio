"""Public site, page, category and product response handlers."""

from urllib.parse import unquote

from domain import block_data, categories, pages, shop, site_chrome
from shared.responses import Ctx


async def shop_index_response(ctx: Ctx):
    products = await shop.list_products(ctx.env, only_active=True)
    cards = [shop.public_summary(product, await shop.list_variants(ctx.env, product["id"]), await shop.list_images(ctx.env, product["id"])) for product in products]
    return ctx.json({"products": cards})


async def site_response(ctx: Ctx):
    env = ctx.env
    by_id = {page["id"]: page for page in await pages.list_pages(env, only_published=True)}
    slugs = {category["slug"] for category in await categories.list_all(env)}
    resolved = []
    for item in await site_chrome.list_menu(env):
        href = None
        if item["targetKind"] == "page":
            page = by_id.get(item["target"])
            if page is not None:
                href = "/" if page["isHome"] else page["path"]
        elif item["targetKind"] == "category":
            wanted = [part for part in item["target"].replace("+", ",").split(",") if part]
            if wanted and all(slug in slugs for slug in wanted):
                href = f"/shop/c/{item['target']}"
        else:
            href = item["target"]
        if href is not None:
            resolved.append({"id": item["id"], "parentId": item["parentId"], "label": item["label"], "href": href})
    return ctx.json({"settings": await site_chrome.get_settings(env), "menu": resolved})


async def page_response(ctx: Ctx, page: dict | None):
    if page is None or page["status"] != "published":
        return ctx.error("Page not found", 404)
    version = await pages.current_version(ctx.env, page["id"])
    if version is None:
        return ctx.error("Page not found", 404)
    return ctx.json(_page_payload(page, await block_data.hydrate(ctx.env, pages.blocks_of_snapshot(version["payload"]))))


async def preview_response(ctx: Ctx, token: str):
    page_id = await pages.redeem_preview_token(ctx.env, token)
    if page_id is None:
        return ctx.error("Preview link has expired", 404)
    page = await pages.get_page(ctx.env, page_id)
    if page is None:
        return ctx.error("Page not found", 404)
    return ctx.json(_page_payload(page, await block_data.hydrate(ctx.env, await pages.list_blocks(ctx.env, page_id))))


def _page_payload(page: dict, blocks: list) -> dict:
    return {"title": page["title"], "path": page["path"], "showHeader": page["showHeader"], "showFooter": page["showFooter"], "shareDescription": page["shareDescription"], "shareImagePath": page["shareImagePath"], "blocks": blocks}


async def category_index_response(ctx: Ctx):
    counts = await categories.counts(ctx.env)
    return ctx.json({"categories": [{"slug": category["slug"], "title": category["title"], "productCount": counts.get(category["id"], 0)} for category in await categories.list_all(ctx.env)]})


async def category_page_response(ctx: Ctx, raw: str):
    try:
        slugs, mode = categories.parse_filter(unquote(raw))
    except ValueError:
        return ctx.error("Category not found", 404)
    found = await categories.by_slugs(ctx.env, slugs)
    if len(found) != len(slugs):
        return ctx.error("Category not found", 404)
    products = await categories.products_in(ctx.env, [category["id"] for category in found], mode)
    cards = [shop.public_summary(product, await shop.list_variants(ctx.env, product["id"]), await shop.list_images(ctx.env, product["id"])) for product in products]
    return ctx.json({"title": categories.filter_title(found, mode), "description": found[0]["description"] if len(found) == 1 else "", "mode": mode, "categories": [{"slug": category["slug"], "title": category["title"]} for category in found], "products": cards})


async def shop_product_response(ctx: Ctx, slug: str):
    try:
        slug = shop.validate_slug(unquote(slug))
    except ValueError:
        return ctx.error("Product not found", 404)
    product = await shop.get_product_by_slug(ctx.env, slug)
    if product is None or product["status"] != "active":
        return ctx.error("Product not found", 404)
    return ctx.json(shop.public_detail(product, await shop.list_variants(ctx.env, product["id"]), await shop.list_images(ctx.env, product["id"]), await categories.of_product(ctx.env, product["id"])))
