"""Delivery methods and what each one costs for a given order.

The free-shipping threshold is per method rather than shared. Handing a parcel
to a courier and handing it over a convenience-store counter cost different
amounts, and one threshold for both forces the number up to whatever the
dearest option needs.
"""

from common import d1_rows, utc_timestamp


METHODS = ("cvs_c2c", "home")

MAX_LABEL = 40
MAX_FEE = 1000
# A threshold below this would be met by almost every order, which is a way of
# offering free delivery without meaning to.
MIN_FREE_THRESHOLD = 1
MAX_FREE_THRESHOLD = 100000


def validate_method(method: str) -> str:
    if method not in METHODS:
        raise ValueError(f"Delivery method must be one of: {', '.join(METHODS)}")
    return method


def validate_fee(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Delivery fee must be a whole number")
    if value < 0 or value > MAX_FEE:
        raise ValueError(f"Delivery fee must be between 0 and {MAX_FEE}")
    return value


def validate_free_threshold(value) -> int | None:
    """None means the method never ships free, which is the default."""

    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Free delivery threshold must be a whole number")
    if value < MIN_FREE_THRESHOLD or value > MAX_FREE_THRESHOLD:
        raise ValueError(
            f"Free delivery threshold must be between {MIN_FREE_THRESHOLD} and {MAX_FREE_THRESHOLD}"
        )
    return value


def method_row(row: dict) -> dict:
    threshold = row["free_threshold"]
    return {
        "method": row["method"],
        "label": row["label"],
        "enabled": bool(row["enabled"]),
        "fee": int(row["fee"]),
        "freeThreshold": int(threshold) if threshold is not None else None,
        "position": int(row["position"]),
    }


def fee_for(method: dict, subtotal: int) -> int:
    """What this method costs on an order of `subtotal`.

    The threshold is met at exactly the stated amount, not above it: a shop
    that advertises free delivery over 1,000 and then charges on an order of
    exactly 1,000 has an argument on its hands, not a rule.
    """

    threshold = method["freeThreshold"]
    if threshold is not None and subtotal >= threshold:
        return 0
    return method["fee"]


def quote(methods: list[dict], subtotal: int) -> list[dict]:
    """Every method a customer may pick, priced for this basket."""

    return [
        {
            "method": method["method"],
            "label": method["label"],
            "fee": fee_for(method, subtotal),
            "freeThreshold": method["freeThreshold"],
        }
        for method in methods
        if method["enabled"]
    ]


async def list_methods(env, *, only_enabled: bool = False) -> list[dict]:
    query = "SELECT * FROM shipping_methods"
    if only_enabled:
        query += " WHERE enabled = 1"
    query += " ORDER BY position, method"
    return [method_row(row) for row in await d1_rows(env.DB.prepare(query))]


async def get_method(env, method: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM shipping_methods WHERE method = ?1").bind(method))
    return method_row(rows[0]) if rows else None


async def save_method(env, method: str, *, label: str, enabled: bool, fee: int, free_threshold: int | None) -> None:
    await env.DB.prepare(
        "UPDATE shipping_methods SET label = ?2, enabled = ?3, fee = ?4, free_threshold = ?5, updated_at = ?6"
        " WHERE method = ?1"
    ).bind(method, label, 1 if enabled else 0, fee, free_threshold, utc_timestamp()).run()
