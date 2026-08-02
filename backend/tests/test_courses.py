"""The course skeleton phase 2 needs in order to point an Offer at one.

Sections, lessons, video and the whole editor are phase 5. What has to exist
now is an identity an `offer_components` row can name, and the status rule
that decides whether an Offer may be sold: a draft course has nothing to
watch, so selling access to it is selling nothing.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def courses():
    from domain import courses as module

    return module


class TestValidation:
    def test_a_slug_looks_like_a_url_segment(self, courses):
        assert courses.validate_slug("  Watercolour-Flowers ") == "watercolour-flowers"

    @pytest.mark.parametrize("value", ["-lead", "trail-", "double--hyphen", "under_score", "空白 字", ""])
    def test_anything_that_would_not_survive_a_url_is_refused(self, courses, value):
        with pytest.raises(ValueError):
            courses.validate_slug(value)

    def test_a_title_is_required(self, courses):
        with pytest.raises(ValueError):
            courses.validate_title("  ")

    @pytest.mark.parametrize("value", ["draft", "published", "archived"])
    def test_the_three_states_a_course_can_be_in(self, courses, value):
        assert courses.validate_status(value) == value

    @pytest.mark.parametrize("value", ["live", "", "DRAFT", None])
    def test_nothing_else_is_a_status(self, courses, value):
        with pytest.raises(ValueError):
            courses.validate_status(value)


class TestSellability:
    """Only a published course may be attached to an Offer that is for sale."""

    def test_a_published_course_may_back_a_sellable_offer(self, courses):
        assert courses.is_sellable({"status": "published"}) is True

    @pytest.mark.parametrize("status", ["draft", "archived"])
    def test_a_draft_or_archived_course_may_not(self, courses, status):
        assert courses.is_sellable({"status": status}) is False


class TestRowMapping:
    def test_a_row_written_before_the_display_fields_existed_still_reads(self, courses):
        """The picker lists courses long before anybody fills these in, and a
        row from before migration 0031 has none of the columns at all."""

        mapped = courses.course_row(
            {
                "id": "c1",
                "slug": "watercolour",
                "title": "水彩入門",
                "status": "draft",
                "created_at": 1,
                "updated_at": 2,
            }
        )

        assert mapped["id"] == "c1"
        assert mapped["summary"] == ""
        assert mapped["coverMediaId"] is None
        assert mapped["level"] == "all"
        assert mapped["language"] == "zh-Hant"


class TestSlugUniqueness:
    def test_an_existing_slug_is_reported_as_taken(self, courses):
        database = FakeDatabase({"SELECT id FROM courses": [{"id": "other"}]})

        assert asyncio.run(courses.slug_taken(make_env(database), "watercolour")) is True

    def test_the_course_being_edited_does_not_conflict_with_itself(self, courses):
        database = FakeDatabase()

        asyncio.run(courses.slug_taken(make_env(database), "watercolour", excluding="c1"))

        query, bindings = database.reads[0]
        assert "id != ?2" in query
        assert bindings == ("watercolour", "c1")


def section(title="第一章", lessons=None, section_id=None):
    entry = {"title": title, "lessons": lessons if lessons is not None else [lesson()]}
    if section_id is not None:
        entry["id"] = section_id
    return entry


def lesson(title="工具介紹", **extra):
    return {"title": title, "contentHtml": "<p>你好</p>", **extra}


class TestOutlineValidation:
    """The whole tree is checked before any of it is written.

    Replacing an outline means deleting what is there. Finding out halfway
    through that a lesson names a video that is still encoding would leave a
    course with half its chapters gone and no way back.
    """

    def test_a_normal_outline_survives(self, courses):
        validated = courses.validate_outline([section()])

        assert validated[0]["title"] == "第一章"
        assert validated[0]["lessons"][0]["title"] == "工具介紹"

    def test_positions_come_from_the_order_sent(self, courses):
        """A client can send whatever numbers it likes, including duplicates."""

        validated = courses.validate_outline(
            [section(title="第二章", lessons=[lesson("A"), lesson("B")]), section(title="第一章")]
        )

        assert [entry["position"] for entry in validated] == [0, 1]
        assert [item["position"] for item in validated[0]["lessons"]] == [0, 1]

    def test_a_section_needs_a_name(self, courses):
        with pytest.raises(ValueError):
            courses.validate_outline([section(title="  ")])

    def test_a_lesson_needs_a_name(self, courses):
        with pytest.raises(ValueError):
            courses.validate_outline([section(lessons=[lesson("")])])

    def test_a_section_with_no_lessons_is_allowed_while_writing(self, courses):
        """An author adds the chapter before its contents. Publishing is where
        that gets refused, not saving."""

        assert courses.validate_outline([section(lessons=[])])[0]["lessons"] == []

    def test_an_outline_beyond_what_one_request_should_carry_is_refused(self, courses):
        with pytest.raises(ValueError):
            courses.validate_outline([section() for _ in range(courses.MAX_SECTIONS + 1)])

    def test_a_preview_flag_is_a_boolean_not_whatever_arrived(self, courses):
        validated = courses.validate_outline([section(lessons=[lesson(isPreview="yes")])])

        assert validated[0]["lessons"][0]["isPreview"] is True

    def test_html_is_cleaned_before_it_is_stored(self, courses):
        """The editor's own restrictions are a convenience, not a boundary."""

        validated = courses.validate_outline(
            [section(lessons=[{"title": "X", "contentHtml": "<p>好<script>alert(1)</script></p>"}])]
        )

        assert "script" not in validated[0]["lessons"][0]["contentHtml"]


class TestPublishChecks:
    """What must be true before anyone can be sold access to this."""

    def _course(self, **extra):
        return {
            "id": "c1", "slug": "watercolour", "title": "水彩入門", "status": "draft",
            "summary": "兩小時學會水彩", "coverMediaId": "media-1", **extra,
        }

    def _outline(self, lessons=None):
        return [{"title": "第一章", "lessons": lessons if lessons is not None else [
            {"title": "工具介紹", "videoAssetId": "asset-1", "isPreview": False},
        ]}]

    def test_a_complete_course_passes(self, courses):
        assert courses.publish_problems(self._course(), self._outline(), ready_asset_ids={"asset-1"}) == []

    def test_a_course_with_no_summary_is_not_ready_to_sell(self, courses):
        """The summary is what a product page leads with."""

        problems = courses.publish_problems(self._course(summary=""), self._outline(), ready_asset_ids={"asset-1"})

        assert "summary" in [problem["field"] for problem in problems]

    def test_a_course_with_no_lessons_is_refused(self, courses):
        problems = courses.publish_problems(self._course(), [], ready_asset_ids=set())

        assert [problem["field"] for problem in problems] == ["outline"]

    def test_a_chapter_with_nothing_in_it_is_refused(self, courses):
        problems = courses.publish_problems(self._course(), self._outline(lessons=[]), ready_asset_ids=set())

        assert [problem["field"] for problem in problems] == ["outline"]

    def test_a_lesson_whose_video_is_still_encoding_is_refused(self, courses):
        """Publishing it would sell access to a spinner."""

        problems = courses.publish_problems(self._course(), self._outline(), ready_asset_ids=set())

        assert [problem["field"] for problem in problems] == ["video"]
        assert "工具介紹" in problems[0]["message"]

    def test_a_text_only_lesson_needs_no_video(self, courses):
        outline = self._outline(lessons=[{"title": "課前準備", "videoAssetId": None, "isPreview": False}])

        assert courses.publish_problems(self._course(), outline, ready_asset_ids=set()) == []

    def test_every_problem_is_reported_at_once(self, courses):
        """An author fixing one thing per save is a bad afternoon."""

        problems = courses.publish_problems(
            self._course(summary="", coverMediaId=None), self._outline(), ready_asset_ids=set()
        )

        assert len(problems) >= 3


class TestWhatAVisitorSees:
    """A product page describes a course without giving it away."""

    def _outline(self):
        return [
            {
                "title": "第一章",
                "lessons": [
                    {"id": "l1", "title": "工具介紹", "contentHtml": "<p>免費看</p>",
                     "videoAssetId": "asset-1", "isPreview": True, "position": 0},
                    {"id": "l2", "title": "調色練習", "contentHtml": "<p>付費內容</p>",
                     "videoAssetId": "asset-2", "isPreview": False, "position": 1},
                ],
            }
        ]

    def _course(self):
        return {
            "id": "c1", "slug": "watercolour", "title": "水彩入門", "status": "published",
            "summary": "兩小時學會", "coverMediaId": "media-1", "instructorName": "王老師",
            "level": "beginner", "language": "zh-Hant",
        }

    def test_a_locked_lesson_is_named_but_not_given_away(self, courses):
        public = courses.public_outline(self._outline())

        locked = public[0]["lessons"][1]
        assert locked["title"] == "調色練習"
        assert "contentHtml" not in locked
        assert locked["isPreview"] is False

    def test_a_preview_lesson_shows_its_content(self, courses):
        public = courses.public_outline(self._outline())

        assert public[0]["lessons"][0]["contentHtml"] == "<p>免費看</p>"

    def test_no_lesson_reveals_which_video_file_it_uses(self, courses):
        """An asset id is a thing to go looking for. Playback is granted by
        the gateway, never by knowing a name."""

        public = courses.public_outline(self._outline())

        for lesson in public[0]["lessons"]:
            assert "videoAssetId" not in lesson

    def test_the_page_can_say_how_much_there_is(self, courses):
        summary = courses.public_course(self._course(), self._outline())

        assert summary["lessonCount"] == 2
        assert summary["sections"][0]["title"] == "第一章"


class TestWhatAProductPageShows:
    """A product that grants courses describes them, once each."""

    def _database(self, components, *, course_status="published"):
        return FakeDatabase(
            {
                "SELECT * FROM offer_components": components,
                "SELECT * FROM courses WHERE id IN": [{
                    "id": "course-1", "slug": "watercolour", "title": "水彩入門", "status": course_status,
                    "created_at": 0, "updated_at": 0, "summary": "兩小時學會", "description_html": "<p>介紹</p>",
                    "cover_media_id": "m1", "instructor_name": "王老師", "instructor_bio_html": "",
                    "level": "beginner", "language": "zh-Hant", "audience_html": "", "outcomes_html": "",
                    "prerequisites_html": "", "materials_html": "", "published_at": 1,
                }],
                "SELECT * FROM course_sections": [
                    {"id": "s1", "course_id": "course-1", "title": "第一章", "position": 0,
                     "created_at": 0, "updated_at": 0}
                ],
                "SELECT * FROM course_lessons": [{
                    "id": "l1", "section_id": "s1", "title": "工具介紹", "content_html": "<p>付費</p>",
                    "video_asset_id": "a1", "is_preview": 0, "position": 0,
                }],
            }
        )

    def _component(self, component_id="course-1", offer_id="off-1"):
        return {
            "id": f"oc-{offer_id}", "offer_id": offer_id, "component_type": "course",
            "component_id": component_id, "quantity": 1, "access_days": None, "position": 0,
        }

    def test_a_product_with_no_course_asks_the_database_nothing(self, courses):
        """An ordinary physical product must not pay for a course query."""

        database = FakeDatabase()

        listed = asyncio.run(courses.public_for_offers(make_env(database), []))

        assert listed == []
        assert database.reads == []

    def test_a_course_offer_describes_its_course(self, courses):
        database = self._database([self._component()])

        listed = asyncio.run(courses.public_for_offers(make_env(database), ["off-1"]))

        assert listed[0]["title"] == "水彩入門"
        assert listed[0]["lessonCount"] == 1

    def test_a_course_two_offers_share_is_described_once(self, courses):
        """"Online" and "with materials" grant the same course. Listing it
        twice would read as two different courses."""

        database = self._database([self._component(offer_id="off-1"), self._component(offer_id="off-2")])

        listed = asyncio.run(courses.public_for_offers(make_env(database), ["off-1", "off-2"]))

        assert len(listed) == 1

    def test_a_locked_lesson_is_named_without_its_content(self, courses):
        database = self._database([self._component()])

        listed = asyncio.run(courses.public_for_offers(make_env(database), ["off-1"]))

        lesson = listed[0]["sections"][0]["lessons"][0]
        assert lesson["title"] == "工具介紹"
        assert "contentHtml" not in lesson

    def test_an_unpublished_course_is_not_described_at_all(self, courses):
        """A draft cannot be sold, so a product page has nothing to say about
        it — and saying anything would leak an unfinished course."""

        database = self._database([self._component()], course_status="draft")

        assert asyncio.run(courses.public_for_offers(make_env(database), ["off-1"])) == []


class TestTheCoverPicture:
    """The course carries an id; a page needs a URL.

    The editor drew `\/media-assets\/{coverMediaId}` — a path that does not
    exist, because the URL a picture is served at is built from its object key,
    not from its id. The result was a broken-image icon on every course with a
    cover, and nothing in the network log but a 404 for a route nobody wrote.

    Resolved here rather than looked up by the page: the storefront needs the
    same URL for the same picture, and two callers guessing at it is how the
    first guess went unnoticed.
    """

    def _course(self, courses, media_rows):
        database = FakeDatabase(
            {
                "SELECT * FROM courses WHERE id": [
                    {
                        "id": "c1", "slug": "night-shining-waves", "title": "夜光海浪",
                        "status": "draft", "cover_media_id": "media-1",
                        "created_at": 1, "updated_at": 2,
                    }
                ],
                "FROM media WHERE id IN": media_rows,
            }
        )
        return asyncio.run(courses.get_course(make_env(database), "c1"))

    def test_the_cover_comes_back_as_something_a_page_can_draw(self, courses):
        course = self._course(
            courses,
            [
                {
                    "id": "media-1", "object_key": "_media/abc123.webp", "file_name": "cover.webp",
                    "title": "", "alt": "", "byte_size": 10, "width": 1216, "height": 832,
                    "created_at": 1,
                }
            ],
        )

        assert course["coverPath"] == "/media-assets/abc123.webp"
        # The id stays: it is what the picker sets and what the form saves.
        assert course["coverMediaId"] == "media-1"

    def test_a_cover_whose_picture_has_been_deleted_is_nothing_rather_than_broken(self, courses):
        """A page that draws nothing beats a page that draws the browser's
        broken-image icon, which reads as the page being at fault."""

        course = self._course(courses, [])

        assert course["coverPath"] is None

    def test_a_course_with_no_cover_asks_the_library_nothing(self, courses):
        database = FakeDatabase(
            {
                "SELECT * FROM courses WHERE id": [
                    {
                        "id": "c1", "slug": "s", "title": "t", "status": "draft",
                        "cover_media_id": None, "created_at": 1, "updated_at": 2,
                    }
                ]
            }
        )

        course = asyncio.run(courses.get_course(make_env(database), "c1"))

        assert course["coverPath"] is None
        assert not [sql for sql in database.statements if "FROM media" in sql]
