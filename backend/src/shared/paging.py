"""Pages of rows, and the numbers a pager needs to draw itself.

Three lists used to answer with "the newest 200, and by the way there were
more". That is not a list — it is a promise that the rest exists somewhere you
cannot reach. An owner looking for an order from March could not get to it, and
the only advice on offer was to search for something they were trying to find.

So: `LIMIT ? OFFSET ?`, and a `COUNT(*)` beside it. Offsets rather than cursors
because the owner wants to jump to page 4, and because a shop's orders are
counted in thousands — the scan an offset costs at that size is not worth
giving up page numbers for.

The count is a second query on purpose. Getting it out of the same statement
means a window function over every matching row, which is more expensive than
counting them, and D1 charges for rows read.
"""

MAX_PER_PAGE = 100
DEFAULT_PER_PAGE = 50


def clamp(page, per_page, *, default_per_page: int = DEFAULT_PER_PAGE) -> tuple[int, int]:
    """What `?page=` and `?perPage=` actually mean.

    Anything unreadable becomes the default rather than an error: a pager is
    navigation, and a broken URL should land somewhere sensible instead of on
    a message about integers.
    """

    try:
        wanted_page = int(page)
    except (TypeError, ValueError):
        wanted_page = 1
    try:
        wanted_size = int(per_page)
    except (TypeError, ValueError):
        wanted_size = default_per_page
    return max(1, wanted_page), max(1, min(wanted_size, MAX_PER_PAGE))


def window(page: int, per_page: int) -> tuple[int, int]:
    """The LIMIT and OFFSET for that page."""

    return per_page, (page - 1) * per_page


def envelope(rows: list, total: int, page: int, per_page: int) -> dict:
    """What every paged endpoint puts around its rows.

    `pages` is computed here rather than in each browser: three copies of
    ceil-division is three chances to be off by one on an exact multiple, and
    that is the case nobody tests by hand.
    """

    return {
        "total": total,
        "page": page,
        "perPage": per_page,
        "pages": max(1, -(-total // per_page)),
        "count": len(rows),
    }
