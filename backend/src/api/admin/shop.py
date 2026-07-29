"""Catalogue editing on the admin deployment.

`admin_main.dispatch` has already established that the caller is signed in, so
nothing here repeats that check. What it does do is validate every field on
the way in: these rows end up in customer-facing pages and, before long, in
the amount charged to a card.
"""

from domain import categories, shipping, shop
from shared import sanitize
from shared.responses import Ctx


async def _detail(ctx: Ctx, product: dict) -> dict:
    """A product with everything the editor needs to render it in one go."""

    variants = await shop.list_variants(ctx.env, product["id"])
    return {
        "product": product,
        "variants": variants,
        "salesMode": shop.sales_mode(variants),
        "defaultOffer": next((variant for variant in variants if variant["isDefault"]), None),
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


def _default_offer_fields(body: dict) -> dict:
    """The single-offer editor deliberately has no customer-facing title."""

    return {
        "sku": shop.validate_text(str(body.get("sku") or ""), shop.MAX_SKU, "SKU", required=False),
        "price": shop.validate_price(body.get("price")),
        "stock": shop.validate_stock(body.get("stock")),
        "enabled": bool(body.get("enabled", True)),
    }


async def handle(ctx: Ctx):
    path, method, env = ctx.path, ctx.method, ctx.env

    if path == "/api/shipping-methods" and method == "GET":
        return ctx.json({"methods": await shipping.list_methods(env)})

    if path == "/api/shipping-methods" and method == "PUT":
        try:
            raw = (await ctx.json_body()).get("methods")
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
            fields = _category_fields(await ctx.json_body())
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid category", 400)
        if await categories.slug_taken(env, fields["slug"]):
            return ctx.error("Another category already uses that slug", 409)
        await categories.create(env, **fields)
        return ctx.json({"categories": await categories.list_all(env), "counts": await categories.counts(env)}, 201)

    # Before the {id} route below, or "order" would be read as a category id.
    if path == "/api/categories/order" and method == "PUT":
        try:
            raw_ids = (await ctx.json_body()).get("ids")
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
            fields = _category_fields(await ctx.json_body())
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
            body = await ctx.json_body()
            fields = _product_fields(body)
            offer_fields = _default_offer_fields(body)
            category_ids = _category_ids(body)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid product", 400)
        if await shop.slug_taken(env, fields["slug"]):
            return ctx.error("Another product already uses that slug", 409)
        if fields["status"] == "active" and not offer_fields["enabled"]:
            return ctx.error("上架商品至少需要一筆啟用的銷售方案", 409)
        try:
            product_id = await shop.create_product_with_default_offer(env, **fields, **offer_fields)
        except Exception:
            return ctx.error("商品與銷售資訊建立失敗，請再試一次", 500)
        if category_ids is not None:
            await categories.set_for_product(env, product_id, category_ids)
        return ctx.json(await _detail(ctx, await shop.get_product(env, product_id)), 201)

    # Before the {id} routes below, or the name would be read as a product id.
    if path == "/api/products/unsellable" and method == "GET":
        return ctx.json({"products": await shop.unsellable_active_products(env)})

    # Before the {id} routes below, or "order" would be read as a product id.
    if path == "/api/products/order" and method == "PUT":
        try:
            raw_ids = (await ctx.json_body()).get("ids")
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
                body = await ctx.json_body()
                fields = _product_fields(body)
                category_ids = _category_ids(body)
                has_sales_fields = any(key in body for key in ("price", "sku", "stock", "enabled"))
                default_fields = _default_offer_fields(body) if has_sales_fields else None
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid product", 400)
            if await shop.slug_taken(env, fields["slug"], excluding=product_id):
                return ctx.error("Another product already uses that slug", 409)
            default_offer = await shop.get_default_offer(env, product_id)
            if default_fields is not None and default_offer is None:
                return ctx.error("這個商品沒有單一銷售方案", 409)
            if fields["status"] == "active":
                changing_id = default_offer["id"] if default_fields is not None and default_offer is not None else None
                enabled = default_fields["enabled"] if default_fields is not None else None
                if not await shop.can_be_active(env, product_id, changing_offer_id=changing_id, offer_enabled=enabled):
                    return ctx.error("上架商品至少需要一筆啟用的銷售方案", 409)
            await shop.update_product(env, product_id, **fields)
            if default_fields is not None and default_offer is not None:
                try:
                    await shop.update_variant(
                        env,
                        default_offer["id"],
                        title="",
                        sku=default_fields["sku"],
                        price=default_fields["price"],
                        stock=default_fields["stock"],
                        enabled=default_fields["enabled"],
                    )
                except ValueError as error:
                    # Stock this page cannot own — a shared inventory item, or
                    # more than one. Saying so beats a 500 the admin cannot act on.
                    return ctx.error(str(error), 409)
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
                fields = _variant_fields(await ctx.json_body())
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid variant", 400)
            if await shop.count_variants(env, product_id) >= shop.MAX_VARIANTS:
                return ctx.error(f"A product can hold at most {shop.MAX_VARIANTS} variants", 409)
            if await shop.get_default_offer(env, product_id) is not None:
                return ctx.error("請先將單一商品轉為多方案，再新增方案", 409)
            await shop.create_variant(env, product_id, **fields)
            return ctx.json(await _detail(ctx, product), 201)

        if tail == "offers/convert-to-multi" and method == "POST":
            try:
                title = shop.validate_text(
                    str((await ctx.json_body()).get("title") or ""), shop.MAX_VARIANT_TITLE, "方案名稱"
                )
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid offer conversion", 400)
            if not await shop.convert_default_offer_to_multi(env, product_id, title=title):
                return ctx.error("這個商品不是單一方案模式", 409)
            return ctx.json(await _detail(ctx, await shop.get_product(env, product_id)))

        if tail == "images/order" and method == "PUT":
            try:
                raw_ids = (await ctx.json_body()).get("ids")
                if not isinstance(raw_ids, list):
                    raise ValueError("Expected an array of photo ids")
                ordered = [shop.validate_product_id(str(image_id)) for image_id in raw_ids]
            except (ValueError, AttributeError) as error:
                return ctx.error(str(error) or "Invalid photo ordering", 400)
            if not await shop.reorder_images(env, product_id, ordered):
                return ctx.error("Photo ordering must contain every product photo exactly once", 400)
            return ctx.json(await _detail(ctx, product))

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
        if not shop.PRODUCT_ID_PATTERN.fullmatch(variant_id):
            return ctx.error("Invalid variant id", 400)
        variant = await shop.get_variant(env, variant_id)
        if variant is None:
            return ctx.error("Variant not found", 404)
        product = await shop.get_product(env, variant["productId"])

        if method == "DELETE":
            if variant["isDefault"]:
                return ctx.error("單一銷售方案不能刪除；請先轉為多方案", 409)
            if product["status"] == "active" and not await shop.can_be_active(
                env, product["id"], changing_offer_id=variant_id, offer_enabled=False
            ):
                return ctx.error("上架商品至少需要一筆啟用的銷售方案", 409)
            await shop.delete_variant(env, variant_id)
            return ctx.json(await _detail(ctx, product))

        if variant["isDefault"]:
            return ctx.error("單一銷售方案請由商品的銷售資訊儲存", 409)
        try:
            body = await ctx.json_body()
            fields = _variant_fields(body)
        except (ValueError, AttributeError) as error:
            return ctx.error(str(error) or "Invalid variant", 400)
        enabled = bool(body.get("enabled", True))
        if product["status"] == "active" and not await shop.can_be_active(
            env, product["id"], changing_offer_id=variant_id, offer_enabled=enabled
        ):
            return ctx.error("上架商品至少需要一筆啟用的銷售方案", 409)
        try:
            await shop.update_variant(env, variant_id, **fields, enabled=enabled)
        except ValueError as error:
            return ctx.error(str(error), 409)
        return ctx.json(await _detail(ctx, product))

    if path.startswith("/api/images/") and method == "DELETE":
        image_id = path.removeprefix("/api/images/")
        if not shop.PRODUCT_ID_PATTERN.fullmatch(image_id):
            return ctx.error("Invalid image id", 400)
        removed = await shop.delete_image(env, image_id)
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
