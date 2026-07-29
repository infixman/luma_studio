"""A course as an identity an Offer can point at.

Phase 2 needs no more than that: a name, a slug and a status. Sections,
lessons, video and the editor arrive in phase 5 as additive columns, so
nothing here should grow a second copy of what that phase will own.

The status is the part that matters now. An Offer that grants a draft course
sells access to nothing, so `is_sellable` is what the Offer rules consult
before an Offer may be enabled or a product made active.
"""

import re

from shared.common import d1_changed, d1_rows, urlsafe_token, utc_timestamp, validate_choice, validate_text


SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

MAX_SLUG = 64
MAX_TITLE = 120

STATUSES = ("draft", "published", "archived")


def validate_slug(slug) -> str:
    slug = str(slug or "").strip().lower()
    if not slug:
        raise ValueError("Slug is required")
    if len(slug) > MAX_SLUG:
        raise ValueError(f"Slug must be {MAX_SLUG} characters or fewer")
    if not SLUG_PATTERN.fullmatch(slug):
        raise ValueError("Slug may use lowercase letters, numbers and single hyphens between them")
    return slug


def validate_title(value) -> str:
    return validate_text(value, MAX_TITLE, "Title")


def validate_status(value) -> str:
    return validate_choice(value, STATUSES, "Status")


def is_sellable(course: dict) -> bool:
    """Whether an Offer granting this course may be enabled.

    Archived is deliberately not sellable and deliberately not revoking:
    it stops new sales without taking the course away from anyone who
    already bought it.
    """

    return course["status"] == "published"


def course_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "slug": row["slug"],
        "title": row["title"],
        "status": row["status"],
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


async def list_courses(env, *, status: str | None = None) -> list[dict]:
    query = "SELECT * FROM courses"
    bindings: list = []
    if status is not None:
        query += " WHERE status = ?1"
        bindings.append(status)
    query += " ORDER BY title"
    return [course_row(row) for row in await d1_rows(env.DB.prepare(query).bind(*bindings))]


async def get_course(env, course_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM courses WHERE id = ?1").bind(course_id))
    return course_row(rows[0]) if rows else None


async def slug_taken(env, slug: str, *, excluding: str | None = None) -> bool:
    query = "SELECT id FROM courses WHERE slug = ?1"
    bindings: list = [slug]
    if excluding is not None:
        query += " AND id != ?2"
        bindings.append(excluding)
    return bool(await d1_rows(env.DB.prepare(query).bind(*bindings)))


async def create_course(env, *, slug: str, title: str, status: str) -> str:
    course_id, now = urlsafe_token(18), utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO courses (id, slug, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
    ).bind(course_id, slug, title, status, now).run()
    return course_id


async def update_course(env, course_id: str, *, slug: str, title: str, status: str) -> bool:
    result = await env.DB.prepare(
        "UPDATE courses SET slug = ?2, title = ?3, status = ?4, updated_at = ?5 WHERE id = ?1"
    ).bind(course_id, slug, title, status, utc_timestamp()).run()
    return d1_changed(result)
