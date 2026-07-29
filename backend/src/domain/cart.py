"""Turning what a browser remembers into what the shop will actually sell.

The cart lives in the visitor's localStorage and holds nothing but offer ids
and quantities. Every price, every name and every judgement about availability
is recomputed here from the database, on every request. A number that arrives
from a browser is a request, not a fact.

Expansion goes through `offers.resolve_offer` — the same call the order takes.
"Available" on the cart page and "available" at checkout have to come from one
rule, or a customer gets shown a price they cannot be charged.

The old `variantId` name is still accepted. A cart saved months ago says
`variantId` and that browser has no idea a rename happened.
"""

from domain import offers, shop


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

# An offer that grants a course is bought once. A second copy would be a
# second payment for the same access, which is a refund waiting to happen.
MAX_COURSE_QUANTITY = 1


class CartError(Exception):
    """The submitted cart is malformed, as opposed to merely unavailable."""


def parse_lines(raw) -> list[dict]:
    """Read the browser's cart into ids and quantities, or refuse it.

    Refusing is for shapes no honest client sends. Things that are merely no
    longer true — an offer that vanished, stock that ran out — are reported
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
        offer_id = str(entry.get("offerId") or "")
        # Both names are the same value. Sending two different ones is a
        # client bug, and guessing which was meant is how you charge for the
        # wrong thing.
        if variant_id and offer_id and variant_id != offer_id:
            raise CartError("variantId and offerId must match")
        resolved_id = offer_id or variant_id

        quantity = entry.get("quantity")
        if isinstance(quantity, bool) or not isinstance(quantity, int):
            raise CartError("Quantity must be a whole number")
        if quantity < 1 or quantity > MAX_QUANTITY:
            raise CartError(f"Quantity must be between 1 and {MAX_QUANTITY}")
        if not resolved_id:
            raise CartError("Each cart line needs an offer")

        # Two lines for the same offer is a client-side merge that did not
        # happen, not an error worth rejecting the whole cart over.
        lines[resolved_id] = min(lines.get(resolved_id, 0) + quantity, MAX_QUANTITY)

    return [
        {"variantId": offer_id, "offerId": offer_id, "quantity": quantity}
        for offer_id, quantity in lines.items()
    ]


def _stock_needed(quotes: list[dict]) -> dict[str, int]:
    """How much of each inventory item the whole cart wants.

    Totalled across lines before anything is compared to stock: the same kit
    in two lines is one pile, and checking each line alone would promise it
    twice.
    """

    needed: dict[str, int] = {}
    for quote in quotes:
        for component in quote["resolved"]["components"]:
            if component["type"] == "inventory":
                needed[component["targetId"]] = needed.get(component["targetId"], 0) + component["requiredQuantity"]
    return needed


async def price_lines(env, lines: list[dict]) -> dict:
    """Rebuild each line from the database and total what remains sellable.

    A line can survive with its quantity reduced, disappear entirely, or turn
    out to cost more than the browser remembered. All three are reported, so
    the page can say what changed instead of silently charging a new number.
    """

    quotes: list[dict] = []
    problems: list[dict] = []

    for line in lines:
        # Normally this arrives from `parse_lines` with both names set. Taking
        # either here means a caller holding an older shape still works, which
        # is the same courtesy the browser's stored cart gets.
        offer_id = line.get("offerId") or line["variantId"]
        resolved = await offers.resolve_offer(env, offer_id, line["quantity"])

        # A disabled offer, an unlisted product and a deleted row are the same
        # event to a customer: it is not for sale any more.
        if resolved is None or not resolved["offerEnabled"] or not resolved["productActive"]:
            problems.append({"variantId": offer_id, "offerId": offer_id, "reason": "unavailable"})
            continue

        # Something the offer promises is gone. Quoting the rest would sell a
        # kit-and-course bundle as a course.
        if resolved["componentUnavailable"] or not resolved["components"]:
            problems.append(
                {
                    "variantId": offer_id,
                    "offerId": offer_id,
                    "title": resolved["productTitle"],
                    "reason": "component_unavailable",
                }
            )
            continue

        quantity = line["quantity"]
        if resolved["containsCourse"] and quantity > MAX_COURSE_QUANTITY:
            problems.append(
                {
                    "variantId": offer_id,
                    "offerId": offer_id,
                    "title": resolved["productTitle"],
                    "reason": "quantity_not_allowed",
                    "available": MAX_COURSE_QUANTITY,
                }
            )
            quantity = MAX_COURSE_QUANTITY
            resolved = await offers.resolve_offer(env, offer_id, quantity)

        quotes.append({"offerId": offer_id, "quantity": quantity, "resolved": resolved})

    # Stock is judged once, on the totals, so two lines wanting the same kit
    # cannot both be told there is enough.
    needed = _stock_needed(quotes)
    available = {
        component["targetId"]: component["availableStock"]
        for quote in quotes
        for component in quote["resolved"]["components"]
        if component["type"] == "inventory"
    }

    priced: list[dict] = []
    subtotal = 0
    shipping_subtotal = 0
    remaining = dict(available)

    for quote in quotes:
        resolved = quote["resolved"]
        quantity = quote["quantity"]

        # How many whole copies of this line the remaining stock allows.
        limit = quantity
        for component in resolved["components"]:
            if component["type"] != "inventory":
                continue
            per_copy = component["quantity"]
            spare = remaining.get(component["targetId"], 0)
            limit = min(limit, spare // per_copy if per_copy else quantity)

        if limit <= 0:
            problems.append(
                {
                    "variantId": quote["offerId"],
                    "offerId": quote["offerId"],
                    "title": resolved["productTitle"],
                    "reason": "out_of_stock",
                }
            )
            continue

        if limit < quantity:
            problems.append(
                {
                    "variantId": quote["offerId"],
                    "offerId": quote["offerId"],
                    "title": resolved["productTitle"],
                    "reason": "reduced",
                    "available": limit,
                }
            )
            quantity = limit

        for component in resolved["components"]:
            if component["type"] == "inventory":
                remaining[component["targetId"]] -= component["quantity"] * quantity

        product = await shop.get_product(env, resolved["productId"])
        images = await shop.list_images(env, resolved["productId"]) if product else []
        line_total = resolved["price"] * quantity
        subtotal += line_total
        if resolved["requiresShipping"]:
            # A mixed offer counts in full: its price cannot be split between
            # the course and the kit without inventing a number nobody set.
            shipping_subtotal += line_total

        lowest = min(
            (remaining[component["targetId"]] for component in resolved["components"] if component["type"] == "inventory"),
            default=None,
        )
        priced.append(
            {
                "variantId": quote["offerId"],
                "offerId": quote["offerId"],
                "productSlug": product["slug"] if product else "",
                "productTitle": resolved["productTitle"],
                "variantTitle": resolved["offerTitle"] or "",
                "offerTitle": resolved["offerTitle"],
                "imagePath": images[0]["path"] if images else None,
                "unitPrice": resolved["price"],
                "quantity": quantity,
                "lineTotal": line_total,
                "containsCourse": resolved["containsCourse"],
                "requiresShipping": resolved["requiresShipping"],
                "components": [
                    {"type": component["type"], "title": component["targetTitle"]}
                    for component in resolved["components"]
                ],
                "stockLeft": lowest if lowest is not None and lowest <= shop.LOW_STOCK_THRESHOLD else None,
            }
        )

    return {
        "lines": priced,
        "problems": problems,
        "subtotal": subtotal,
        # Only what actually ships counts towards free delivery. A digital
        # line must not push a cart over a physical threshold.
        "shippingSubtotal": shipping_subtotal,
        "requiresShipping": any(line["requiresShipping"] for line in priced),
        "containsCourse": any(line["containsCourse"] for line in priced),
    }
