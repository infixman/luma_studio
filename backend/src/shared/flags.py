"""Switches for things that are built but not yet safe to sell.

The server decides. A flag the client reads is a flag an attacker reads too,
and "the button was hidden" has never stopped anybody calling the endpoint
underneath it — so the front end may use these to decide what to draw, and the
back end uses them to decide what to allow.

Unset is off. A deployment that has not been told to sell courses should not
start selling them because a variable was missing.

Exactly `"1"` is on. Accepting "true" as well would mean two spellings, then
three, and then one that quietly does not work on the day it matters.
"""

from shared.common import env_var


COURSE_CATALOG = "COURSE_CATALOG_ENABLED"
COURSE_CHECKOUT = "COURSE_CHECKOUT_ENABLED"
COURSE_LEARNING = "COURSE_LEARNING_ENABLED"
VIDEO_UPLOAD = "VIDEO_UPLOAD_ENABLED"

ALL = (COURSE_CATALOG, COURSE_CHECKOUT, COURSE_LEARNING, VIDEO_UPLOAD)


def enabled(env, name: str) -> bool:
    return env_var(env, name) == "1"


def snapshot(env) -> dict[str, bool]:
    """Every flag at once, for the back office to show what is live."""

    return {name: enabled(env, name) for name in ALL}
