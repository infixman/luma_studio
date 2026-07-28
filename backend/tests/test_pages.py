"""Page paths, block validation, and what the public end refuses to serve."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def pages():
    import pages as module

    return module


def page_record(page_id="p1", path="/about", status="published", is_home=0):
    return {
        "id": page_id,
        "path": path,
        "title": "關於我們",
        "status": status,
        "is_home": is_home,
        "position": 0,
        "created_at": 1,
        "updated_at": 1,
    }


class TestPaths:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("/about", "/about"),
            ("about", "/about"),
            ("/About/", "/about"),
            ("  /about/team  ", "/about/team"),
            ("/refund-policy", "/refund-policy"),
        ],
    )
    def test_a_path_is_normalised(self, pages, raw, expected):
        assert pages.validate_path(raw) == expected

    @pytest.mark.parametrize("raw", ["/about team", "/about_us", "/-lead", "/trail-", "/about//team", "/a" * 100])
    def test_shapes_that_are_not_paths_are_refused(self, pages, raw):
        with pytest.raises(pages.PageError):
            pages.validate_path(raw)

    def test_the_root_is_refused_in_favour_of_the_home_flag(self, pages):
        """Two ways to be the home page is one way too many."""

        with pytest.raises(pages.PageError):
            pages.validate_path("/")

    @pytest.mark.parametrize(
        "raw", ["/shop", "/shop/c/art-kits", "/cart", "/checkout", "/orders", "/card", "/api/health", "/admin"]
    )
    def test_reserved_prefixes_cannot_be_claimed(self, pages, raw):
        """A page at /shop would shadow the entire shop, silently."""

        with pytest.raises(pages.PageError):
            pages.validate_path(raw)

    def test_a_path_merely_starting_with_the_same_letters_is_fine(self, pages):
        assert pages.validate_path("/shopping-guide") == "/shopping-guide"


class TestBlocks:
    def test_a_text_block_keeps_only_its_body(self, pages):
        block_type, config = pages.validate_block("text", {"body": "# 標題", "somethingElse": 1})
        assert block_type == "text"
        assert config == {"body": "# 標題"}

    def test_an_unknown_type_is_refused(self, pages):
        """A block the frontend cannot render looks like data loss to whoever
        wrote it, so it never gets stored in the first place."""

        with pytest.raises(pages.PageError):
            pages.validate_block("weather-widget", {})

    def test_a_config_that_is_not_an_object_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("text", ["not", "a", "dict"])

    def test_an_oversized_body_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("text", {"body": "a" * (pages.MAX_TEXT + 1)})


class TestReadingStoredBlocks:
    def test_a_stored_block_round_trips(self, pages):
        row = {"id": "b1", "type": "text", "config": json.dumps({"body": "hi"}), "position": 0}
        assert pages.block_row(row)["config"] == {"body": "hi"}

    @pytest.mark.parametrize(
        "row",
        [
            {"id": "b1", "type": "weather-widget", "config": "{}", "position": 0},
            {"id": "b1", "type": "text", "config": "not json", "position": 0},
            {"id": "b1", "type": "text", "config": "[]", "position": 0},
        ],
    )
    def test_a_block_that_no_longer_makes_sense_is_dropped_not_raised(self, pages, row):
        """One stale row must not take a published page down with it.

        A missing paragraph is a smaller failure than a blank page.
        """

        assert pages.block_row(row) is None


@pytest.fixture
def call():
    import main
    import migrations

    def run(request, database=None):
        migrations._applied_names = None
        worker = main.Default()
        worker.env = make_env(database or FakeDatabase())
        return asyncio.run(worker.fetch(request))

    return run


class TestPublicPages:
    def test_a_published_page_is_served(self, call):
        database = FakeDatabase({"FROM pages WHERE path": [page_record()]})
        response = call(FakeRequest("/api/pages?path=/about"), database)
        assert response.status == 200
        assert response.json()["title"] == "關於我們"

    def test_a_draft_is_not_reachable(self, call):
        """The back office previews drafts with the same components, so there
        is no reason for one to be fetchable here at all."""

        database = FakeDatabase({"FROM pages WHERE path": [page_record(status="draft")]})
        assert call(FakeRequest("/api/pages?path=/about"), database).status == 404

    def test_an_unknown_path_is_not_found(self, call):
        assert call(FakeRequest("/api/pages?path=/nope")).status == 404

    def test_a_reserved_path_is_not_found_rather_than_queried(self, call):
        database = FakeDatabase()
        assert call(FakeRequest("/api/pages?path=/shop"), database).status == 404
        assert not any("FROM pages WHERE path" in statement for statement in database.statements)

    def test_no_home_page_is_a_404_not_an_error(self, call):
        """The storefront falls back to its built-in home when this 404s."""

        assert call(FakeRequest("/api/pages/home")).status == 404

    def test_a_home_page_is_served_without_naming_its_path(self, call):
        database = FakeDatabase({"FROM pages WHERE is_home": [page_record(path="/welcome", is_home=1)]})
        response = call(FakeRequest("/api/pages/home"), database)
        assert response.status == 200
        assert response.json()["path"] == "/welcome"


class TestAdminPages:
    @pytest.fixture
    def admin_call(self):
        import admin_main
        import migrations

        def run(request, answers=None):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}], **(answers or {})}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
            )
            return asyncio.run(worker.fetch(request))

        return run

    def signed_in(self, path, method="GET"):
        return FakeRequest(
            path,
            method,
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
            host="admin-api.luma-studio.tw",
        )

    def test_the_list_is_reachable(self, admin_call):
        assert admin_call(self.signed_in("/api/pages")).status == 200

    def test_reorder_is_not_read_as_a_page_id(self, admin_call):
        assert admin_call(self.signed_in("/api/pages/order", "PUT")).status == 400

    def test_an_unknown_page_is_reported_as_missing(self, admin_call):
        assert admin_call(self.signed_in("/api/pages/" + "a" * 18)).status == 404

    def test_an_unknown_block_is_reported_as_missing(self, admin_call):
        assert admin_call(self.signed_in("/api/blocks/" + "a" * 18, "DELETE")).status == 404

    def test_pages_are_closed_without_a_session(self, admin_call):
        anonymous = FakeRequest(
            "/api/pages", "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host="admin-api.luma-studio.tw"
        )
        assert admin_call(anonymous).status == 401
