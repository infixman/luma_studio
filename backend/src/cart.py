"""Turning what a browser remembers into what the shop will actually sell.

The cart lives in the visitor's localStorage and holds nothing but variant
ids and quantities. Every price, every name and every judgement about
availability is recomputed here from the database, on every request. A number
that arrives from a browser is a request, not a fact.

The same function serves the cart page and, later, checkout — so that the
totals a customer is shown and the totals they are charged cannot be produced
by two pieces of code that disagree.
"""

import shop


# How many different items a cart may hold. This one is about the Worker: one
# line is one row to look up, and a scripted request should not be able to ask
# for a thousand.
MAX_LINES = 20

# How many of one thing. There is no shop-imposed limit: whatever is on the
# shelf is for sale, and `price_lines` is what knows how much that is — it
# reduces the line and says "only N left". The number here is not a policy,
# it is the largest quantity the shop could ever hold, so anything above it
# is a broken client rather than a customer buying a lot.
MAX_QUANTITY = shop.MAX_STOCK


class CartError(Exception):
    """The submitted cart is malformed, as opposed to merely unavailable."""


def parse_lines(raw) -> list[dict]:
    """Read the browser's cart into ids and quantities, or refuse it.

    Refusing is for shapes no honest client sends. Things that are merely no
    longer true — a variant that vanished, stock that ran out — are reported
    per line by `price_lines`, because the customer needs to see which item
    the problem is about.
    """

    if not isinstance(raw, list):
        raise CartError("Expected a list of cart lines")
    if len(raw) > MAX_LINES:
        raise CartError(f"A cart can hold at most {MAX_LINES} different items")

    lines: dict[str, int] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            raise CartError("Each cart line must be an object")
        variant_id = str(entry.get("variantId") or "")
        quantity = entry.get("quantity")
        if isinstance(quantity, bool) or not isinstance(quantity, int):
            raise CartError("Quantity must be a whole number")
        if quantity < 1 or quantity > MAX_QUANTITY:
            raise CartError(f"Quantity must be between 1 and {MAX_QUANTITY}")
        if not variant_id:
            raise CartError("Each cart line needs a variant")
        # Two lines for the same variant is a client-side merge that did not
        # happen, not an error worth rejecting the whole cart over.
        lines[variant_id] = min(lines.get(variant_id, 0) + quantity, MAX_QUANTITY)

    return [{"variantId": variant_id, "quantity": quantity} for variant_id, quantity in lines.items()]


async def price_lines(env, lines: list[dict]) -> dict:
    """Rebuild each line from the database and total what remains sellable.

    A line can survive with its quantity reduced, disappear entirely, or turn
    out to cost more than the browser remembered. All three are reported, so
    the page can say what changed instead of silently charging a new number.
    """

    priced: list[dict] = []
    problems: list[dict] = []
    subtotal = 0

    for line in lines:
        variant = await shop.get_variant(env, line["variantId"])
        product = await shop.get_product(env, variant["productId"]) if variant else None

        # A disabled variant, an unlisted product and a deleted row are the
        # same event to a customer: it is not for sale any more.
        if variant is None or not variant["enabled"] or product is None or product["status"] != "active":
            problems.append({"variantId": line["variantId"], "reason": "unavailable"})
            continue

        if variant["stock"] <= 0:
            problems.append(
                {"variantId": variant["id"], "title": product["title"], "reason": "out_of_stock"}
            )
            continue

        quantity = min(line["quantity"], variant["stock"])
        if quantity < line["quantity"]:
            problems.append(
                {
                    "variantId": variant["id"],
                    "title": product["title"],
                    "reason": "reduced",
                    "available": variant["stock"],
                }
            )

        images = await shop.list_images(env, product["id"])
        line_total = variant["price"] * quantity
        subtotal += line_total
        priced.append(
            {
                "variantId": variant["id"],
                "productSlug": product["slug"],
                "productTitle": product["title"],
                "variantTitle": variant["title"],
                "imagePath": images[0]["path"] if images else None,
                "unitPrice": variant["price"],
                "quantity": quantity,
                "lineTotal": line_total,
                "stockLeft": variant["stock"] if variant["stock"] <= shop.LOW_STOCK_THRESHOLD else None,
            }
        )

    return {"lines": priced, "problems": problems, "subtotal": subtotal}
