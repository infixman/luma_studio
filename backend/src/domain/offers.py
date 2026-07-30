"""What an Offer delivers, and the single place that works it out.

An Offer carries the price. What the customer receives is a flat list of
components, each naming a Course or an InventoryItem — never another Offer,
which is what keeps bundles from nesting and from referring to themselves.

Nothing here is stored twice. Whether an Offer needs posting, whether it
grants access, whether it is a bundle: all of it is read off the components at
the moment it is asked for. A `product_type` column would be a second answer
that drifts from the first the day someone edits the components and forgets to
update it, and the two answers disagreeing means either shipping a download or
losing a parcel.

`resolve_offer` is the only expansion. The cart and the order both call it, so
"available" on the product page and "available" at checkout cannot come from
two different rules.
"""

from shared.common import d1_rows, urlsafe_token, utc_timestamp


COMPONENT_TYPES = ("course", "inventory")

MAX_COMPONENTS = 20
MAX_COMPONENT_QUANTITY = 100
MAX_ACCESS_DAYS = 3650


def _whole_number(value, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be a whole number")
    return value


def validate_component(raw: dict, position: int) -> dict:
    """One entry, with the rules that differ by type applied.

    Derived fields are not accepted from the client at all. `requiresShipping`
    is something the server works out; taking it as input would let a caller
    describe a course as needing postage.
    """

    component_type = raw.get("type")
    if component_type not in COMPONENT_TYPES:
        raise ValueError(f"Component type must be one of: {', '.join(COMPONENT_TYPES)}")

    component_id = str(raw.get("componentId") or "").strip()
    if not component_id:
        raise ValueError("Component target is required")

    quantity = _whole_number(raw.get("quantity", 1), "Quantity")
    access_days = raw.get("accessDays")

    if component_type == "course":
        # Buying two of a course would be paying twice for one grant. The
        # quantity that varies is how many of the *offer* are bought, and
        # that rule lives in the cart.
        if quantity != 1:
            raise ValueError("A course component is always one")
        if access_days is not None:
            access_days = _whole_number(access_days, "Access days")
            if access_days < 1 or access_days > MAX_ACCESS_DAYS:
                raise ValueError(f"Access days must be between 1 and {MAX_ACCESS_DAYS}")
    else:
        if quantity < 1 or quantity > MAX_COMPONENT_QUANTITY:
            raise ValueError(f"Quantity must be between 1 and {MAX_COMPONENT_QUANTITY}")
        if access_days is not None:
            raise ValueError("A physical component has no viewing window")

    return {
        "type": component_type,
        "componentId": component_id,
        "quantity": quantity,
        "accessDays": access_days,
        "position": position,
    }


def validate_components(entries) -> list[dict]:
    """The whole set at once, before any of it is written.

    Validating entry by entry as it is saved can leave an Offer holding half
    of what was meant: the course but not the kit. The caller replaces the
    set, so the set is what gets checked.
    """

    if not isinstance(entries, list):
        raise ValueError("Components must be a list")
    if len(entries) > MAX_COMPONENTS:
        raise ValueError(f"An offer can hold at most {MAX_COMPONENTS} components")

    validated, seen = [], set()
    for position, raw in enumerate(entries):
        if not isinstance(raw, dict):
            raise ValueError("Each component must be an object")
        component = validate_component(raw, position)
        key = (component["type"], component["componentId"])
        if key in seen:
            raise ValueError("The same item cannot be added twice; change the quantity instead")
        seen.add(key)
        validated.append(component)
    return validated


async def validate_targets(env, components: list[dict]) -> None:
    """Every component has to name something that exists and can be delivered.

    `component_id` points into one of two tables depending on `component_type`,
    which is not something a foreign key can express, so nothing but this
    check stands between a saved Offer and a component that delivers nothing.

    A *draft* course passes deliberately. An admin builds the product and the
    course in whichever order suits them, and refusing to save would force one
    order on them for no reason. What a draft course must not do is let the
    Offer go on sale, and that is `sale_blockers`. An *archived* target is
    refused outright: archiving means "stop using this", so adding it to
    something new is always a mistake.
    """

    if not components:
        return

    wanted_courses = [c["componentId"] for c in components if c["type"] == "course"]
    wanted_items = [c["componentId"] for c in components if c["type"] == "inventory"]

    found_courses = await _targets(env, "courses", wanted_courses)
    found_items = await _targets(env, "inventory_items", wanted_items)

    for course_id in wanted_courses:
        course = found_courses.get(course_id)
        if course is None:
            raise ValueError("找不到指定的課程")
        if course["status"] == "archived":
            raise ValueError(f"課程「{course['title']}」已封存，不能加入新的銷售方案")

    for item_id in wanted_items:
        item = found_items.get(item_id)
        if item is None:
            raise ValueError("找不到指定的庫存品")
        if item.get("archived_at") is not None:
            raise ValueError(f"庫存品「{item['title']}」已封存，不能加入新的銷售方案")


def sale_blockers(resolved: dict) -> list[dict]:
    """Why this Offer may not be enabled, in words the editor can show.

    Returned rather than raised: the editor wants to list everything that is
    wrong at once, and an admin fixing three problems one exception at a time
    is a worse afternoon than it needs to be.
    """

    problems: list[dict] = []

    if resolved["componentUnavailable"]:
        problems.append(
            {
                "reason": "component_unavailable",
                "message": "有內容已被停用或封存，請重新設定商品內容",
            }
        )

    if not resolved["components"] and not resolved["componentUnavailable"]:
        # Nothing is wrong with any component; there are none. Charging for
        # that is its own mistake and deserves its own words.
        problems.append({"reason": "no_components", "message": "這個方案還沒有任何內容，無法販售"})

    for component in resolved["components"]:
        if component["type"] == "course" and component["courseStatus"] != "published":
            problems.append(
                {
                    "reason": "course_not_published",
                    "message": f"課程「{component['targetTitle']}」尚未發布，發布後才能販售",
                }
            )

    return problems


def contains_course(components: list[dict]) -> bool:
    return any(component["type"] == "course" for component in components)


def requires_shipping(components: list[dict]) -> bool:
    """One physical component is enough to make the whole line a parcel."""

    return any(component["type"] == "inventory" for component in components)


def digital_only(components: list[dict]) -> bool:
    """An empty offer is not digital: there is nothing to grant either."""

    return contains_course(components) and not requires_shipping(components)


def is_bundle(components: list[dict]) -> bool:
    return len(components) > 1


def component_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "offerId": row["offer_id"],
        "type": row["component_type"],
        "componentId": row["component_id"],
        "quantity": int(row["quantity"]),
        "accessDays": None if row["access_days"] is None else int(row["access_days"]),
        "position": int(row["position"]),
    }


async def list_components(env, offer_id: str) -> list[dict]:
    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM offer_components WHERE offer_id = ?1 ORDER BY position").bind(offer_id)
    )
    return [component_row(row) for row in rows]


async def references_of(env, component_type: str, component_id: str) -> list[str]:
    """Which Offers name this target, so it is archived rather than deleted."""

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT offer_id FROM offer_components WHERE component_type = ?1 AND component_id = ?2"
        ).bind(component_type, component_id)
    )
    return [row["offer_id"] for row in rows]


async def replace_components(env, offer_id: str, components: list[dict]) -> None:
    """Swap the whole set.

    Deleting then inserting is not atomic here — D1 has no interactive
    transaction — but the alternative, letting the client add and remove one
    at a time, leaves half-built offers behind on any failed request. The set
    has already been validated, including that every target exists, so the
    window between the two statements holds a set that was correct a moment
    ago rather than one that was never correct.
    """

    now = utc_timestamp()
    await env.DB.prepare("DELETE FROM offer_components WHERE offer_id = ?1").bind(offer_id).run()
    for component in components:
        await env.DB.prepare(
            "INSERT INTO offer_components"
            " (id, offer_id, component_type, component_id, quantity, access_days, position, created_at, updated_at)"
            " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)"
        ).bind(
            urlsafe_token(18),
            offer_id,
            component["type"],
            component["componentId"],
            component["quantity"],
            component["accessDays"],
            component["position"],
            now,
        ).run()


async def provision_simple_inventory(env, offer_id: str, *, title: str, sku: str, stock: int, enabled: bool) -> str:
    """Give a newly created Offer the InventoryItem its stock lives in.

    Migration 0028 did this for every Offer that already existed. Without the
    same step at creation time, an Offer made after the migration would be the
    only kind with nowhere to keep its stock.

    The item takes the Offer's id, exactly as the backfill did, so provenance
    stays readable and there is never a mapping table to keep in step.
    """

    now = utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO inventory_items (id, sku, title, stock, enabled, archived_at, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)"
    ).bind(offer_id, sku, title, stock, 1 if enabled else 0, now).run()
    await env.DB.prepare(
        "INSERT INTO offer_components"
        " (id, offer_id, component_type, component_id, quantity, access_days, position, created_at, updated_at)"
        " VALUES (?1, ?2, 'inventory', ?3, 1, NULL, 0, ?4, ?4)"
    ).bind(urlsafe_token(18), offer_id, offer_id, now).run()
    return offer_id


async def set_simple_offer_stock(env, offer_id: str, stock: int, *, actor: str = "", reason: str = ""):
    """Edit the one number the product page means by "stock".

    Only valid where the Offer has exactly one InventoryItem and nothing else
    uses it. A shared kit's count belongs to every Offer that includes it, so
    changing it from one product's editor would silently change the others;
    those go through the inventory screens, where the sharing is visible.

    The mirror write to `product_variants.stock` is deliberate and temporary.
    Orders still reserve against that column until phase 3, so dropping it now
    would let the shop sell stock that is not there. It is confined to this
    one function so phase 7 has a single line to delete.
    """

    from domain import inventory

    components = await list_components(env, offer_id)
    physical = [component for component in components if component["type"] == "inventory"]

    if not physical:
        raise ValueError("這個方案沒有實體內容，沒有庫存可以設定")
    if len(physical) > 1:
        raise ValueError("這個方案包含多項實體內容，請到庫存品管理調整")

    item_id = physical[0]["componentId"]
    if len(await references_of(env, "inventory", item_id)) > 1:
        raise ValueError("這個庫存品被多個方案共用，請到庫存品管理調整")

    change = await inventory.adjust_stock(
        env, item_id, stock, actor=actor, reason=reason or "商品編輯頁調整"
    )
    if change is None:
        raise ValueError("找不到對應的庫存品")

    await env.DB.prepare("UPDATE product_variants SET stock = ?2 WHERE id = ?1").bind(offer_id, stock).run()
    return change


async def _offer_with_product(env, offer_id: str) -> dict | None:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT v.id, v.product_id, v.title, v.price, v.enabled,"
            " p.status AS product_status, p.title AS product_title"
            " FROM product_variants v JOIN products p ON p.id = v.product_id"
            " WHERE v.id = ?1"
        ).bind(offer_id)
    )
    return rows[0] if rows else None


async def _targets(env, table: str, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    placeholders = ", ".join(f"?{index + 1}" for index in range(len(ids)))
    rows = await d1_rows(env.DB.prepare(f"SELECT * FROM {table} WHERE id IN ({placeholders})").bind(*ids))
    return {row["id"]: row for row in rows}


async def resolve_offer(env, offer_id: str, purchase_quantity: int = 1) -> dict | None:
    """Expand one Offer into what it costs and what it delivers.

    Returns None when the Offer does not exist. Everything else — the Offer
    being disabled, the product not being active, a target having been
    archived — is reported in the result rather than hidden, because the cart
    has to say *why* a line cannot be bought.
    """

    offer = await _offer_with_product(env, offer_id)
    if offer is None:
        return None

    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM offer_components WHERE offer_id = ?1 ORDER BY position").bind(offer_id)
    )
    components = [component_row(row) for row in rows]

    inventory = await _targets(
        env, "inventory_items", [c["componentId"] for c in components if c["type"] == "inventory"]
    )
    course_targets = await _targets(env, "courses", [c["componentId"] for c in components if c["type"] == "course"])

    resolved, missing = [], False
    for component in components:
        if component["type"] == "inventory":
            target = inventory.get(component["componentId"])
            if target is None or target.get("archived_at") is not None or not target["enabled"]:
                missing = True
                continue
            resolved.append(
                {
                    "type": "inventory",
                    "targetId": target["id"],
                    "targetTitle": target["title"],
                    "sku": target["sku"],
                    "quantity": component["quantity"],
                    # What has to be reserved for this line as a whole. The
                    # cart adds these up across lines before looking at stock:
                    # the same kit in two lines is one pile.
                    "requiredQuantity": component["quantity"] * purchase_quantity,
                    "availableStock": int(target["stock"]),
                }
            )
        else:
            target = course_targets.get(component["componentId"])
            if target is None or target["status"] == "draft":
                missing = True
                continue
            resolved.append(
                {
                    "type": "course",
                    "targetId": target["id"],
                    "targetTitle": target["title"],
                    "accessDays": component["accessDays"],
                    "courseStatus": target["status"],
                }
            )

    return {
        "offerId": offer["id"],
        "productId": offer["product_id"],
        "productTitle": offer["product_title"],
        "offerTitle": offer["title"] or None,
        "price": int(offer["price"]),
        "purchaseQuantity": purchase_quantity,
        "offerEnabled": bool(offer["enabled"]),
        "productActive": offer["product_status"] == "active",
        "componentUnavailable": missing,
        "containsCourse": contains_course(resolved),
        "requiresShipping": requires_shipping(resolved),
        "digitalOnly": digital_only(resolved),
        "isBundle": is_bundle(resolved),
        "components": resolved,
    }
