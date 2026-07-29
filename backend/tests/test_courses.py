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
    def test_a_row_becomes_the_shape_the_picker_reads(self, courses):
        assert courses.course_row(
            {
                "id": "c1",
                "slug": "watercolour",
                "title": "水彩入門",
                "status": "draft",
                "created_at": 1,
                "updated_at": 2,
            }
        ) == {
            "id": "c1",
            "slug": "watercolour",
            "title": "水彩入門",
            "status": "draft",
            "createdAt": 1,
            "updatedAt": 2,
        }


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
