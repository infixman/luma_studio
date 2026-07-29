"""A course as an identity an Offer can point at.

Phase 2 needs no more than that: a name, a slug and a status. Sections,
lessons, video and the editor arrive in phase 5 as additive columns, so
nothing here should grow a second copy of what that phase will own.

The status is the part that matters now. An Offer that grants a draft course
sells access to nothing, so `is_sellable` is what the Offer rules consult
before an Offer may be enabled or a product made active.
"""

import re

from shared import sanitize
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


# Limits on one request, not on a course. A tree past these is a broken client
# or an attempt to make one Worker request do a day's work.
MAX_SECTIONS = 40
MAX_LESSONS_PER_SECTION = 60
MAX_LESSON_TITLE = 120
MAX_SUMMARY = 300
MAX_HTML = 60_000

LEVELS = ("beginner", "intermediate", "advanced", "all")


def validate_outline(raw) -> list[dict]:
    """Check the whole tree before any of it is written.

    Replacing an outline means deleting what is already there. Discovering
    partway through that a lesson is malformed would leave a course with half
    its chapters gone and nothing to put back.

    Positions come from the order sent rather than from any number in the
    request. Clients send duplicates, gaps and 99s; what they mean is "this
    order", and that is what gets stored.

    HTML is cleaned here, on the way in. The editor restricts what an author
    can type, but that is a convenience — the boundary is the server, and
    content saved through any other route goes through the same door.
    """

    if not isinstance(raw, list):
        raise ValueError("課程大綱格式不正確")
    if len(raw) > MAX_SECTIONS:
        raise ValueError(f"一門課程最多 {MAX_SECTIONS} 個章節")

    sections = []
    for position, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError("章節格式不正確")
        lessons_raw = entry.get("lessons")
        if lessons_raw is None:
            lessons_raw = []
        if not isinstance(lessons_raw, list):
            raise ValueError("單元格式不正確")
        if len(lessons_raw) > MAX_LESSONS_PER_SECTION:
            raise ValueError(f"一個章節最多 {MAX_LESSONS_PER_SECTION} 個單元")

        lessons = []
        for lesson_position, lesson_raw in enumerate(lessons_raw):
            if not isinstance(lesson_raw, dict):
                raise ValueError("單元格式不正確")
            video_asset_id = lesson_raw.get("videoAssetId") or None
            lessons.append(
                {
                    "id": str(lesson_raw.get("id") or "") or None,
                    "title": validate_text(lesson_raw.get("title"), MAX_LESSON_TITLE, "單元名稱"),
                    "contentHtml": sanitize.sanitize_html(
                        validate_text(lesson_raw.get("contentHtml") or "", MAX_HTML, "單元內容", required=False)
                    ),
                    "videoAssetId": str(video_asset_id) if video_asset_id else None,
                    # Whatever arrived, read as the yes/no it has to be.
                    "isPreview": bool(lesson_raw.get("isPreview")),
                    "position": lesson_position,
                }
            )

        sections.append(
            {
                "id": str(entry.get("id") or "") or None,
                "title": validate_text(entry.get("title"), MAX_TITLE, "章節名稱"),
                "position": position,
                # A chapter with nothing in it is fine while writing: authors
                # add the heading before its contents. Publishing refuses it.
                "lessons": lessons,
            }
        )
    return sections


def publish_problems(course: dict, outline: list[dict], *, ready_asset_ids: set[str]) -> list[dict]:
    """Everything standing between this course and being sold.

    All of it at once. An author fixing one thing per save, and being told
    about the next one only after, is a bad afternoon that a list avoids.
    """

    problems: list[dict] = []

    if not (course.get("summary") or "").strip():
        problems.append({"field": "summary", "message": "請填寫課程簡介，商品頁會用它開頭"})
    if not course.get("coverMediaId"):
        problems.append({"field": "cover", "message": "請選擇課程封面"})

    lessons = [lesson for section in outline for lesson in section.get("lessons", ())]
    if not lessons:
        problems.append({"field": "outline", "message": "課程至少要有一個章節與一個單元"})

    for lesson in lessons:
        asset_id = lesson.get("videoAssetId")
        # A lesson with no video is a reading, and perfectly valid. One that
        # names a video still encoding would sell access to a spinner.
        if asset_id and asset_id not in ready_asset_ids:
            problems.append(
                {
                    "field": "video",
                    "message": f"單元「{lesson['title']}」的影片尚未轉檔完成",
                }
            )

    return problems


def total_lessons(outline: list[dict]) -> int:
    return sum(len(section.get("lessons", ())) for section in outline)


def public_outline(outline: list[dict]) -> list[dict]:
    """The table of contents a visitor may see.

    Every lesson is named — knowing what a course covers is the point of the
    page — but only a preview lesson's content comes with it. The rest is what
    the money buys.

    No lesson carries its video asset id. An id is a thing to go looking for,
    and playback is granted by the gateway on the strength of an entitlement,
    never on the strength of knowing a name.
    """

    return [
        {
            "title": section["title"],
            "lessons": [
                {
                    "id": lesson.get("id"),
                    "title": lesson["title"],
                    "isPreview": bool(lesson.get("isPreview")),
                    "hasVideo": bool(lesson.get("videoAssetId")),
                    **({"contentHtml": lesson.get("contentHtml", "")} if lesson.get("isPreview") else {}),
                }
                for lesson in section.get("lessons", ())
            ],
        }
        for section in outline
    ]


def public_course(course: dict, outline: list[dict]) -> dict:
    """A published course as a product page describes it."""

    return {
        "slug": course["slug"],
        "title": course["title"],
        "summary": course.get("summary", ""),
        "descriptionHtml": course.get("descriptionHtml", ""),
        "instructorName": course.get("instructorName", ""),
        "instructorBioHtml": course.get("instructorBioHtml", ""),
        "level": course.get("level", "all"),
        "language": course.get("language", "zh-Hant"),
        "audienceHtml": course.get("audienceHtml", ""),
        "outcomesHtml": course.get("outcomesHtml", ""),
        "prerequisitesHtml": course.get("prerequisitesHtml", ""),
        "materialsHtml": course.get("materialsHtml", ""),
        "lessonCount": total_lessons(outline),
        "sections": public_outline(outline),
    }
