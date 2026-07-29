"""Catalogue editing on the admin deployment.

`admin_main.dispatch` has already established that the caller is signed in, so
nothing here repeats that check. What it does do is validate every field on
the way in: these rows end up in customer-facing pages and, before long, in
the amount charged to a card.
"""

import categories
import sanitize
import shipping
import shop
from responses import Ctx


async def _read_json(ctx: Ctx) -> dict:
    body = await ctx.request.json()
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    return body


async def _detail(ctx: Ctx, product: dict) -> dict:
    """A product with everything the editor needs to render it in one go."""

    return {
        "product": product,
        "variants": await shop.list_variants(ctx.env, product["id"]),
        "images": await shop.list_images(ctx.env, product["id"]),
        "categories": await categories.of_product(ctx.env, product["id"]),
    }


def _product_fields(body: dict) -> dict:
    raw_desc = str(body.get("description") or "")
    desc = sanitize.sanitize_html(raw_desc) if "<" in raw_desc else raw_desc
    return {
        "slug": shop.validate_slug(str(body.get("slug") or "")),
        "title": shop.validate_text(str(body.get("title") or ""), shop.MAX_TITLE, "Title"),
        "description": shop.validate_text(desc, shop.MAX_DESCRIPTION, "Description", required=False),
        "status": shop.validate_status(str(body.get("status") or "draft")),
    }


def _category_fields(body: dict) -> dict:
    return {
        "slug": shop.validate_slug(str(body.get("slug") or "")),
        "title": shop.validate_text(str(body.get("title") or ""), categories.MAX_TITLE, "Title"),
        "description": shop.validate_text(
            str(body.get("description") or ""), categories.MAX_DESCRIPTION, "Description", required=False
        ),
    }


def _category_ids(body: dict) -> list[str] | None:
    """The product's categories, or None when the caller did not mention them.

    None and [] mean different things: the first leaves the categories alone,
    the second clears them. A PUT that forgot the field must not silently
    strip a product out of every category it was in.
    """

    raw = body.get("categoryIds")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError("categoryIds must be a list")
    return [categories.validate_id(str(value)) for value in raw]


def _variant_fields(body: dict) -> dict:
    return {
        "title": shop.validate_text(str(body.get("title") or ""), shop.MAX_VARIANT_TITLE, "Variant name"),
        "sku": shop.validate_text(str(body.get("sku") or ""), shop.MAX_SKU, "SKU", required=False),
        "price": shop.validate_price(body.get("price")),
        "stock": shop.validate_stock(body.get("stock")),
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/shipping-methods" and method == "GET":
        return ctx.json({"methods": await shipping.list_methods(env)})

    if path == "/api/shipping-methods" and method == "PUT":
        try:
            raw = (await _read_json(ctx)).get("methods")
            if not isinstance(raw, list):
                raise ValueError("Expected an array of delivery methods")
            updates = [
                {
                    "method": shipping.validate_method(str(entry.get("method") or "")),
                    "label": shop.validate_text(str(entry.get("label") or ""), shipping.MAX_LABEL, "Label"),
                    "enabled": bool(entry.get("enabled", True)),
                    "fee": shipping.validate_fee(entry.get("fee")),
                    "free_threshold": shipping.validate_free_threshold(entry.get("freeThreshold")),
                }
                for entry in raw
            ]
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid delivery settings", 400)
        # Validate all of them before writing any, so a rejected fee cannot
        # leave the shop half-configured.
        for update in updates:
            await shipping.save_method(env, update.pop("method"), **update)
        return ctx.json({"methods": await shipping.list_methods(env)})

    if path == "/api/categories" and method == "GET":
        return ctx.json({"categories": await categories.list_all(env), "counts": await categories.counts(env)})

    if path == "/api/categories" and method == "POST":
        try:
            fields = _category_fields(await _read_json(ctx))
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid category", 400)
        if await categories.slug_taken(env, fields["slug"]):
            return ctx.error("Another category already uses that slug", 409)
        await categories.create(env, **fields)
        return ctx.json({"categories": await categories.list_all(env), "counts": await categories.counts(env)}, 201)

    # Before the {id} route below, or "order" would be read as a category id.
    if path == "/api/categories/order" and method == "PUT":
        try:
            raw_ids = (await _read_json(ctx)).get("ids")
            if not isinstance(raw_ids, list):
                raise ValueError("Expected an array of category ids")
            ordered = [categories.validate_id(str(value)) for value in raw_ids]
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid ordering", 400)
        await categories.reorder(env, ordered)
        return ctx.json({"categories": await categories.list_all(env), "counts": await categories.counts(env)})

    if path.startswith("/api/categories/") and method in {"PUT", "DELETE"}:
        try:
            category_id = categories.validate_id(path.removeprefix("/api/categories/"))
        except ValueError as error:
            return ctx.error(str(error), 400)
        if await categories.get(env, category_id) is None:
            return ctx.error("Category not found", 404)

        if method == "DELETE":
            # Links go, products stay: a category is a label, and peeling it
            # off is not supposed to throw the product away.
            await categories.remove(env, category_id)
            return ctx.json({"categories": await categories.list_all(env), "counts": await categories.counts(env)})

        try:
            fields = _category_fields(await _read_json(ctx))
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid category", 400)
        if await categories.slug_taken(env, fields["slug"], excluding=category_id):
            return ctx.error("Another category already uses that slug", 409)
        await categories.update(env, category_id, **fields)
        return ctx.json({"categories": await categories.list_all(env), "counts": await categories.counts(env)})

    if path == "/api/products" and method == "GET":
        products = await shop.list_products(env)
        return ctx.json(
            {
                "products": products,
                "variants": {p["id"]: await shop.list_variants(env, p["id"]) for p in products},
                "images": {p["id"]: await shop.list_images(env, p["id"]) for p in products},
                "categories": await categories.list_all(env),
                "counts": await categories.counts(env),
                "productCategories": {p["id"]: await categories.of_product(env, p["id"]) for p in products},
            }
        )

    if path == "/api/products" and method == "POST":
        try:
            body = await _read_json(ctx)
            fields = _product_fields(body)
            category_ids = _category_ids(body)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid product", 400)
        if await shop.slug_taken(env, fields["slug"]):
            return ctx.error("Another product already uses that slug", 409)
        product_id = await shop.create_product(env, **fields)
        if category_ids is not None:
            await categories.set_for_product(env, product_id, category_ids)
        return ctx.json(await _detail(ctx, await shop.get_product(env, product_id)), 201)

    # Before the {id} routes below, or "order" would be read as a product id.
    if path == "/api/products/order" and method == "PUT":
        try:
            raw_ids = (await _read_json(ctx)).get("ids")
            if not isinstance(raw_ids, list):
                raise ValueError("Expected an array of product ids")
            ordered = [shop.validate_product_id(str(product_id)) for product_id in raw_ids]
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid ordering", 400)
        await shop.reorder_products(env, ordered)
        return ctx.json({"products": await shop.list_products(env)})

    if path.startswith("/api/products/"):
        rest = path.removeprefix("/api/products/")
        product_id, _, tail = rest.partition("/")
        try:
            product_id = shop.validate_product_id(product_id)
        except ValueError as error:
            return ctx.error(str(error), 400)

        product = await shop.get_product(env, product_id)
        if product is None:
            return ctx.error("Product not found", 404)

        if not tail and method == "GET":
            return ctx.json(await _detail(ctx, product))

        if not tail and method == "PUT":
            try:
                body = await _read_json(ctx)
                fields = _product_fields(body)
                category_ids = _category_ids(body)
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid product", 400)
            if await shop.slug_taken(env, fields["slug"], excluding=product_id):
                return ctx.error("Another product already uses that slug", 409)
            await shop.update_product(env, product_id, **fields)
            if category_ids is not None:
                await categories.set_for_product(env, product_id, category_ids)
            return ctx.json(await _detail(ctx, await shop.get_product(env, product_id)))

        if not tail and method == "DELETE":
            orphaned = await shop.delete_product(env, product_id)
            for key in orphaned:
                await env.IBON_IMAGES.delete(key)
            return ctx.json({"id": product_id, "deleted": True})

        if tail == "variants" and method == "POST":
            try:
                fields = _variant_fields(await _read_json(ctx))
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid variant", 400)
            if await shop.count_variants(env, product_id) >= shop.MAX_VARIANTS:
                return ctx.error(f"A product can hold at most {shop.MAX_VARIANTS} variants", 409)
            await shop.create_variant(env, product_id, **fields)
            return ctx.json(await _detail(ctx, product), 201)

        if tail == "images" and method == "POST":
            try:
                form = await ctx.request.form_data()
                uploaded = form.get("file")
                if uploaded is None:
                    raise ValueError("Missing multipart file field")
                suffix = shop.validate_image_suffix(str(uploaded.name))
                alt = shop.validate_text(str(form.get("alt") or ""), shop.MAX_ALT, "Alt text", required=False)
                content = await uploaded.bytes()
                if not content or len(content) > shop.MAX_IMAGE_BYTES:
                    raise ValueError("A product photo must be between 1 byte and 3 MB")
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid photo upload", 400)
            if await shop.count_images(env, product_id) >= shop.MAX_IMAGES:
                return ctx.error(f"A product can hold at most {shop.MAX_IMAGES} photos", 409)
            key = shop.image_key(suffix)
            await env.IBON_IMAGES.put(key, content)
            # Store the row only once the object is there, so the page never
            # references a photo that has not finished arriving.
            await shop.add_image(env, product_id, key, alt)
            return ctx.json(await _detail(ctx, product), 201)

        return ctx.error("Unknown product endpoint", 404)

    if path.startswith("/api/variants/") and method in {"PUT", "DELETE"}:
        variant_id = path.removeprefix("/api/variants/")
        variant = await shop.get_variant(env, variant_id)
        if variant is None:
            return ctx.error("Variant not found", 404)
        product = await shop.get_product(env, variant["productId"])

        if method == "DELETE":
            await shop.delete_variant(env, variant_id)
            return ctx.json(await _detail(ctx, product))

        try:
            body = await _read_json(ctx)
            fields = _variant_fields(body)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid variant", 400)
        await shop.update_variant(env, variant_id, **fields, enabled=bool(body.get("enabled", True)))
        return ctx.json(await _detail(ctx, product))

    if path.startswith("/api/images/") and method == "DELETE":
        removed = await shop.delete_image(env, path.removeprefix("/api/images/"))
        if removed is None:
            return ctx.error("Photo not found", 404)
        # Row first, then the object: a page referencing a photo that 404s is
        # worse than an object nobody references.
        await env.IBON_IMAGES.delete(removed["key"])
        product = await shop.get_product(env, removed["productId"])
        if product is None:
            return ctx.json({"deleted": True})
        return ctx.json(await _detail(ctx, product))

    return ctx.error("Unknown shop endpoint", 404)
