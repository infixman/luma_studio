"""A course as an identity an Offer can point at.

Phase 2 needs no more than that: a name, a slug and a status. Sections,
lessons, video and the editor arrive in phase 5 as additive columns, so
nothing here should grow a second copy of what that phase will own.

The status is the part that matters now. An Offer that grants a draft course
sells access to nothing, so `is_sellable` is what the Offer rules consult
before an Offer may be enabled or a product made active.
"""

import re

from domain import media
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
    """The display fields default rather than raising when absent.

    A row read before migration 0031 has none of them, and the video library
    and offer pickers list courses long before anybody fills the fields in.
    """

    return {
        "id": row["id"],
        "slug": row["slug"],
        "title": row["title"],
        "status": row["status"],
        "summary": row.get("summary") or "",
        "descriptionHtml": row.get("description_html") or "",
        "coverMediaId": row.get("cover_media_id"),
        "instructorName": row.get("instructor_name") or "",
        "level": row.get("level") or "all",
        "language": row.get("language") or "zh-Hant",
        "publishedAt": row.get("published_at"),
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
    return await _with_cover(env, course_row(rows[0])) if rows else None


async def _with_cover(env, course: dict) -> dict:
    """Turn the stored media id into a URL a page can draw.

    The course keeps the id — that is what the picker sets and what the form
    saves — and gains the path beside it. The editor used to build
    `/media-assets/{coverMediaId}` itself, which is not where anything is
    served: the URL comes from the object key, and only the library knows it.

    A cover whose picture has since been deleted comes back as nothing, and the
    page draws nothing. The alternative is the browser's broken-image icon,
    which reads as the page being at fault rather than the picture being gone.
    """

    media_id = course.get("coverMediaId")
    if not media_id:
        course["coverPath"] = None
        return course
    found = await media.resolve(env, [media_id])
    item = found.get(media_id)
    course["coverPath"] = item["path"] if item else None
    return course


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


async def update_course(
    env,
    course_id: str,
    *,
    slug: str,
    title: str,
    status: str,
    summary: str = "",
    instructorName: str = "",
    level: str = "all",
    language: str = "zh-Hant",
    coverMediaId: str | None = None,
    descriptionHtml: str = "",
) -> bool:
    """Save a course. The HTML arrives already cleaned.

    `status` is here because saving a draft is the normal case. Publishing is
    its own route: it runs checks a plain save must not.

    A course sells itself with one block of prose. The five other HTML
    columns — instructor_bio_html, audience_html, outcomes_html,
    prerequisites_html, materials_html — are left exactly as they are rather
    than dropped or blanked: nothing writes them now, and whatever an author
    typed into them before is still there if this is ever reversed.
    """

    result = await env.DB.prepare(
        "UPDATE courses SET slug = ?2, title = ?3, status = ?4, summary = ?5, instructor_name = ?6,"
        " level = ?7, language = ?8, cover_media_id = ?9, description_html = ?10,"
        " updated_at = ?11 WHERE id = ?1"
    ).bind(
        course_id,
        slug,
        title,
        status,
        summary,
        instructorName,
        level,
        language,
        coverMediaId,
        descriptionHtml,
        utc_timestamp(),
    ).run()
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
            cover_media_id = lesson_raw.get("coverMediaId") or None
            lessons.append(
                {
                    "id": str(lesson_raw.get("id") or "") or None,
                    "title": validate_text(lesson_raw.get("title"), MAX_LESSON_TITLE, "單元名稱"),
                    "contentHtml": sanitize.sanitize_html(
                        validate_text(lesson_raw.get("contentHtml") or "", MAX_HTML, "單元內容", required=False)
                    ),
                    "videoAssetId": str(video_asset_id) if video_asset_id else None,
                    # Null is the normal state and means "use the frame the
                    # transcode grabbed". Clearing the choice is how somebody
                    # goes back to it, which only works because the default is
                    # never written here.
                    "coverMediaId": str(cover_media_id) if cover_media_id else None,
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
        "level": course.get("level", "all"),
        "language": course.get("language", "zh-Hant"),
        "lessonCount": total_lessons(outline),
        "sections": public_outline(outline),
    }


def section_row(row: dict) -> dict:
    return {"id": row["id"], "title": row["title"], "position": int(row["position"]), "lessons": []}


def lesson_row(row: dict) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "contentHtml": row["content_html"],
        "videoAssetId": row["video_asset_id"],
        # `.get`, because a row read before migration 0041 has no such column.
        "coverMediaId": row.get("cover_media_id"),
        "isPreview": bool(row["is_preview"]),
        "position": int(row["position"]),
    }


async def get_outline(env, course_id: str) -> list[dict]:
    """The whole tree in two queries rather than one per chapter.

    A course with twenty chapters would otherwise be twenty-one round trips
    for a page that is read on every edit.
    """

    sections = [
        section_row(row)
        for row in await d1_rows(
            env.DB.prepare("SELECT * FROM course_sections WHERE course_id = ?1 ORDER BY position").bind(course_id)
        )
    ]
    if not sections:
        return []

    placeholders = ", ".join(f"?{index + 1}" for index in range(len(sections)))
    lessons = await d1_rows(
        env.DB.prepare(
            f"SELECT * FROM course_lessons WHERE section_id IN ({placeholders}) ORDER BY position"
        ).bind(*[section["id"] for section in sections])
    )
    # The chosen pictures, resolved to URLs the editor can draw. The id alone
    # cannot be turned into one: it is built from the object key, and only the
    # media library knows it.
    chosen = await media.resolve(env, [row.get("cover_media_id") for row in lessons])

    by_section: dict[str, list[dict]] = {}
    for row in lessons:
        mapped = lesson_row(row)
        picked = chosen.get(row.get("cover_media_id"))
        mapped["coverPath"] = picked["path"] if picked else None
        by_section.setdefault(row["section_id"], []).append(mapped)
    for section in sections:
        section["lessons"] = by_section.get(section["id"], [])
    return sections


async def replace_outline(env, course_id: str, sections: list[dict]) -> None:
    """Swap the whole tree — except the one thing hanging off it.

    Already validated, so the gap between the delete and the inserts holds a
    tree that was correct a moment ago rather than one that was never correct.

    Section ids are regenerated; nothing outside this table refers to one.
    Lesson ids are not. A member's viewing record is keyed on the lesson id
    (`course_lesson_progress`), and so is a bookmarked lesson URL — an id
    regenerated on save means every member's ticks and positions turn into
    orphans because an author fixed a typo in a chapter title. That is also
    why the two progress readers used to disagree after an edit: the count
    per course still saw the orphaned rows, the per-lesson lookup did not,
    and a card could claim 3/9 finished over a list with no ticks on it.

    A lesson keeps its id only if that id already belongs to this course.
    Anything else — a new row, a stray id from another course, a duplicate —
    gets a fresh one. The membership check is not politeness: reusing a
    foreign id would collide with the row that still owns it, and accepting
    it would let a crafted request move lessons between courses.
    """

    now = utc_timestamp()
    existing = await d1_rows(
        env.DB.prepare(
            "SELECT l.id, l.created_at FROM course_lessons l"
            " JOIN course_sections s ON s.id = l.section_id WHERE s.course_id = ?1"
        ).bind(course_id)
    )
    # Kept with their creation times: a surviving lesson did not become new by
    # being saved, and `created_at` rewritten on every edit had made the field
    # mean "when the outline was last touched".
    ours = {row["id"]: int(row["created_at"]) for row in existing}

    old_sections = await d1_rows(
        env.DB.prepare("SELECT id FROM course_sections WHERE course_id = ?1").bind(course_id)
    )
    for row in old_sections:
        await env.DB.prepare("DELETE FROM course_lessons WHERE section_id = ?1").bind(row["id"]).run()
    await env.DB.prepare("DELETE FROM course_sections WHERE course_id = ?1").bind(course_id).run()

    reused: set[str] = set()
    for section in sections:
        section_id = urlsafe_token(18)
        await env.DB.prepare(
            "INSERT INTO course_sections (id, course_id, title, position, created_at, updated_at)"
            " VALUES (?1, ?2, ?3, ?4, ?5, ?5)"
        ).bind(section_id, course_id, section["title"], section["position"], now).run()
        for lesson in section["lessons"]:
            claimed = lesson["id"]
            keep = claimed is not None and claimed in ours and claimed not in reused
            if keep:
                reused.add(claimed)
            await env.DB.prepare(
                "INSERT INTO course_lessons (id, section_id, title, content_html, video_asset_id,"
                " cover_media_id, is_preview, position, created_at, updated_at)"
                " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
            ).bind(
                claimed if keep else urlsafe_token(18),
                section_id,
                lesson["title"],
                lesson["contentHtml"],
                lesson["videoAssetId"],
                lesson["coverMediaId"],
                1 if lesson["isPreview"] else 0,
                lesson["position"],
                ours[claimed] if keep else now,
                now,
            ).run()

    # A lesson that was dropped from the outline is gone, and its record goes
    # with it — that is deliberate deletion, not a side effect of saving. The
    # rows are orphans either way; deleting them is what keeps the per-course
    # count honest about what still exists to be counted.
    for gone in set(ours) - reused:
        await env.DB.prepare(
            "DELETE FROM course_lesson_progress WHERE lesson_id = ?1"
        ).bind(gone).run()


async def ready_video_asset_ids(env, outline: list[dict]) -> set[str]:
    """Which of this outline's videos are actually playable.

    Asked as one question rather than per lesson, and only about the assets
    this course names — the video library as a whole is not this page's
    business.
    """

    wanted = sorted({
        lesson["videoAssetId"]
        for section in outline
        for lesson in section.get("lessons", ())
        if lesson.get("videoAssetId")
    })
    if not wanted:
        return set()
    placeholders = ", ".join(f"?{index + 1}" for index in range(len(wanted)))
    rows = await d1_rows(
        env.DB.prepare(
            f"SELECT id FROM video_assets WHERE status = 'ready' AND id IN ({placeholders})"
        ).bind(*wanted)
    )
    return {row["id"] for row in rows}


async def update_status(env, course_id: str, status: str) -> bool:
    result = await env.DB.prepare(
        "UPDATE courses SET status = ?2, updated_at = ?3 WHERE id = ?1"
    ).bind(course_id, status, utc_timestamp()).run()
    return d1_changed(result)


async def publish(env, course_id: str) -> bool:
    """`published_at` records the first time only.

    Re-publishing after an edit is not a new course, and overwriting the date
    would lose when it actually went on sale.
    """

    now = utc_timestamp()
    result = await env.DB.prepare(
        "UPDATE courses SET status = 'published', published_at = COALESCE(published_at, ?2), updated_at = ?2"
        " WHERE id = ?1"
    ).bind(course_id, now).run()
    return d1_changed(result)


async def public_for_offers(env, offer_ids: list[str]) -> list[dict]:
    """The courses a product's offers grant, as a visitor may read them.

    Deduplicated by course. "Online" and "with materials" usually grant the
    same course, and listing it once per offer would read as two different
    courses with the same name.

    An unpublished course is left out entirely rather than shown as
    unavailable: it cannot be sold, so the page has nothing to say about it,
    and saying anything would leak an unfinished course.

    A product with no course components asks the database nothing. An ordinary
    physical product should not pay for any of this.
    """

    if not offer_ids:
        return []

    offer_placeholders = ", ".join(f"?{index + 1}" for index in range(len(offer_ids)))
    components = await d1_rows(
        env.DB.prepare(
            f"SELECT * FROM offer_components WHERE component_type = 'course'"
            f" AND offer_id IN ({offer_placeholders})"
        ).bind(*offer_ids)
    )
    course_ids = sorted({row["component_id"] for row in components})
    if not course_ids:
        return []

    course_placeholders = ", ".join(f"?{index + 1}" for index in range(len(course_ids)))
    rows = await d1_rows(
        env.DB.prepare(f"SELECT * FROM courses WHERE id IN ({course_placeholders})").bind(*course_ids)
    )

    listed = []
    for row in rows:
        course = course_row(row)
        # Filtered here rather than in the query. A product has one or two
        # courses, so the difference is nothing, and the rule stays somewhere
        # a test can reach without a database.
        if not is_sellable(course):
            continue
        listed.append(public_course(course, await get_outline(env, course["id"])))
    return listed
