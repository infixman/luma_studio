"""Page paths, block validation, and what the public end refuses to serve."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def pages():
    import pages as module

    return module


def page_record(page_id="p1", path="/about", status="published", is_home=0, description="", image_key=""):
    return {
        "id": page_id,
        "path": path,
        "title": "關於我們",
        "status": status,
        "is_home": is_home,
        "share_description": description,
        "share_image_key": image_key,
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


class TestSharePreview:
    """What a shared link shows, and how it survives the trip to the client."""

    def test_the_stored_key_leaves_as_a_url(self, pages):
        """The page keeps a media object key; the client is handed a path.

        Nothing outside the backend should have to know how one becomes the
        other, and a raw key in a tag would be a broken image.
        """

        row = pages.page_row(page_record(image_key="_media/abc.jpg"))
        assert row["shareImagePath"] == "/media-assets/abc.jpg"

    def test_no_image_is_no_url(self, pages):
        assert pages.page_row(page_record())["shareImagePath"] is None

    def test_a_row_from_before_the_migration_still_maps(self, pages):
        """Both Workers read this table, and only one of them applies schema."""

        older = {key: value for key, value in page_record().items() if not key.startswith("share_")}
        row = pages.page_row(older)
        assert row["shareDescription"] == ""
        assert row["shareImagePath"] is None

    def test_an_empty_description_is_a_real_answer(self, pages):
        """A page with nothing to add lets the card show the title alone."""

        assert pages.validate_share_description("") == ""
        assert pages.validate_share_description(None) == ""

    def test_a_description_longer_than_any_card_shows_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_share_description("字" * (pages.MAX_SHARE_DESCRIPTION + 1))


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


def version(payload="[]", current=1):
    """The row a customer's page actually comes from now."""

    return {
        "id": "v1",
        "page_id": "p1",
        "payload": payload,
        "published_at": 1700000000,
        "published_by": "owner@luma",
        "is_current": current,
    }


class TestPublicPages:
    def test_a_published_page_is_served(self, call):
        database = FakeDatabase(
            {"FROM pages WHERE path": [page_record()], "FROM page_versions": [version()]}
        )
        response = call(FakeRequest("/api/pages?path=/about"), database)
        assert response.status == 200
        assert response.json()["title"] == "關於我們"

    def test_the_share_fields_travel_with_the_page(self, call):
        """The storefront Worker reads these to build the tags a crawler sees,
        so they have to be in the public payload rather than behind the admin."""

        database = FakeDatabase(
            {
                "FROM pages WHERE path": [page_record(description="台中的繪畫教室", image_key="_media/abc.jpg")],
                "FROM page_versions": [version()],
            }
        )
        body = call(FakeRequest("/api/pages?path=/about"), database).json()
        assert body["shareDescription"] == "台中的繪畫教室"
        assert body["shareImagePath"] == "/media-assets/abc.jpg"

    def test_a_draft_is_not_reachable(self, call):
        """The back office previews drafts with the same components, so there
        is no reason for one to be fetchable here at all."""

        database = FakeDatabase({"FROM pages WHERE path": [page_record(status="draft")]})
        assert call(FakeRequest("/api/pages?path=/about"), database).status == 404

    def test_a_page_marked_published_with_no_version_is_not_served(self, call):
        """Nothing has ever been published, so there is nothing to serve. The
        status column alone used to be enough, and would now hand back a page
        with no blocks on it."""

        database = FakeDatabase({"FROM pages WHERE path": [page_record()]})
        assert call(FakeRequest("/api/pages?path=/about"), database).status == 404

    def test_the_blocks_come_from_the_version_not_the_draft(self, call):
        """The draft is what the owner is editing. A customer reading it is
        the problem versions exist to solve."""

        published = '[{"type": "text", "config": {"body": "已發布"}}]'
        database = FakeDatabase(
            {
                "FROM pages WHERE path": [page_record()],
                "FROM page_versions": [version(published)],
                # The draft says something else entirely, and must not appear.
                "FROM page_blocks": [{"id": "b1", "type": "text", "config": '{"markdown": "草稿"}', "position": 0}],
            }
        )
        body = call(FakeRequest("/api/pages?path=/about"), database).json()
        assert [block["config"]["body"] for block in body["blocks"]] == ["已發布"]

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
        database = FakeDatabase(
            {"FROM pages WHERE is_home": [page_record(path="/welcome", is_home=1)], "FROM page_versions": [version()]}
        )
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


class JsonRequest(FakeRequest):
    """A signed-in PUT with a body. The session check belongs to admin_main."""

    def __init__(self, path: str, body, method: str = "PUT"):
        super().__init__(path, method, {"Origin": ADMIN_ORIGIN}, host="admin-api.luma-studio.tw")
        self._body = body

    async def json(self):
        return self._body


def edit(body, database=None):
    """One page edit straight into the handler, returning what it wrote."""

    import pages_admin_api
    from responses import Ctx
    from urllib.parse import parse_qs, urlsplit

    request = JsonRequest("/api/pages/" + "a" * 18, body)
    parts = urlsplit(request.url)
    database = database or FakeDatabase({"FROM pages WHERE id": [page_record()]})
    ctx = Ctx(make_env(database), request, parts.path, parse_qs(parts.query))
    response = asyncio.run(pages_admin_api.handle(ctx))
    written = [bindings for statement, bindings in database.writes if statement.startswith("UPDATE pages SET path")]
    return response, written


SAVED = {"path": "/about", "title": "關於我們", "status": "published"}


class TestEditingTheSharePreview:
    def test_an_image_the_body_never_mentions_is_left_alone(self):
        """The editor only ever learns the image's URL, not the id behind it.

        So a save that says nothing about the image must keep it. Otherwise
        editing a title would quietly strip the page's preview card.
        """

        database = FakeDatabase({"FROM pages WHERE id": [page_record(image_key="_media/kept.jpg")]})
        response, written = edit(SAVED, database)
        assert response.status == 200
        assert written[0][7] == "_media/kept.jpg"

    def test_picking_an_image_stores_the_key_behind_the_id(self):
        """The key, not the id: every crawl needs a URL, and the key is one."""

        database = FakeDatabase(
            {
                "FROM pages WHERE id": [page_record()],
                "SELECT object_key FROM media": [{"object_key": "_media/new.jpg"}],
            }
        )
        _, written = edit({**SAVED, "shareImageId": "abcdefghij12"}, database)
        assert written[0][7] == "_media/new.jpg"

    def test_clearing_the_image_stores_nothing(self):
        database = FakeDatabase({"FROM pages WHERE id": [page_record(image_key="_media/old.jpg")]})
        _, written = edit({**SAVED, "shareImageId": ""}, database)
        assert written[0][7] == ""

    def test_an_id_with_nothing_behind_it_is_refused(self):
        """An image the owner can see in the picker but not in the preview is
        worse than being told to pick again."""

        response, written = edit({**SAVED, "shareImageId": "abcdefghij12"})
        assert response.status == 400
        assert written == []

    def test_the_description_is_saved_with_the_rest_of_the_page(self):
        _, written = edit({**SAVED, "shareDescription": "台中的繪畫教室"})
        assert written[0][6] == "台中的繪畫教室"

    def test_a_description_no_card_could_show_is_refused(self):
        response, _ = edit({**SAVED, "shareDescription": "字" * 400})
        assert response.status == 400


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture
def pages_module():
    import pages as module

    return module


class TestPreviewTokens:
    """The one way an unpublished page is reachable on the public host.

    Three bounds, and the tests are here because no single one of them is
    load-bearing on its own: one page, ten minutes, spent on use.
    """

    def test_minting_stores_a_token_against_one_page(self, pages_module):
        database = FakeDatabase()
        token = run(pages_module.mint_preview_token(make_env(database), "p1"))

        assert pages_module.PREVIEW_TOKEN_PATTERN.fullmatch(token)
        insert = [write for write in database.writes if "INSERT INTO preview_tokens" in write[0]]
        assert len(insert) == 1
        assert insert[0][1][0] == token
        assert insert[0][1][1] == "p1"

    def test_minting_clears_tokens_that_have_expired(self, pages_module):
        """Nothing has to remember to sweep this table on a schedule."""

        database = FakeDatabase()
        run(pages_module.mint_preview_token(make_env(database), "p1"))
        assert any("DELETE FROM preview_tokens WHERE expires_at" in write[0] for write in database.writes)

    def test_a_valid_token_names_its_page(self, pages_module):
        token = "a" * 32
        database = FakeDatabase(
            {"FROM preview_tokens WHERE token": [{"token": token, "page_id": "p1", "expires_at": 4_000_000_000}]}
        )
        assert run(pages_module.redeem_preview_token(make_env(database), token)) == "p1"

    def test_redeeming_spends_the_token(self, pages_module):
        """A preview URL must not become a way to read the draft later."""

        token = "a" * 32
        database = FakeDatabase(
            {"FROM preview_tokens WHERE token": [{"token": token, "page_id": "p1", "expires_at": 4_000_000_000}]}
        )
        run(pages_module.redeem_preview_token(make_env(database), token))
        assert any("DELETE FROM preview_tokens WHERE token" in write[0] for write in database.writes)

    def test_an_expired_token_is_refused_and_still_spent(self, pages_module):
        """Deleting before the expiry check: a late arrival is still a use, and
        leaving it behind would let a slow attempt be retried against a clock."""

        token = "a" * 32
        database = FakeDatabase({"FROM preview_tokens WHERE token": [{"token": token, "page_id": "p1", "expires_at": 1}]})
        assert run(pages_module.redeem_preview_token(make_env(database), token)) is None
        assert any("DELETE FROM preview_tokens WHERE token" in write[0] for write in database.writes)

    def test_an_unknown_token_is_refused(self, pages_module):
        assert run(pages_module.redeem_preview_token(make_env(FakeDatabase()), "a" * 32)) is None

    @pytest.mark.parametrize("bad", ["", "short", "../../etc/passwd", "a" * 200, "has spaces in it!!"])
    def test_a_token_that_is_not_one_never_reaches_the_database(self, pages_module, bad):
        database = FakeDatabase()
        assert run(pages_module.redeem_preview_token(make_env(database), bad)) is None
        assert database.statements == []


class TestReorderingBlocks:
    """A partial order leaves the blocks it left out on their old positions,
    which then collide with the new ones and the page comes back in whatever
    order the database felt like."""

    @staticmethod
    def _call(ids, rows):
        import pages_admin_api
        from responses import Ctx
        from urllib.parse import parse_qs, urlsplit

        page_id = "a" * 18
        request = JsonRequest(f"/api/pages/{page_id}/blocks/order", {"ids": ids})
        parts = urlsplit(request.url)
        database = FakeDatabase(
            {
                "FROM pages WHERE id": [page_record(page_id=page_id)],
                "SELECT id FROM page_blocks": [{"id": row} for row in rows],
            }
        )
        ctx = Ctx(make_env(database), request, parts.path, parse_qs(parts.query))
        response = asyncio.run(pages_admin_api.handle(ctx))
        return response, database

    def test_an_order_missing_a_block_is_refused(self):
        blocks = ["b" * 18, "c" * 18, "d" * 18]
        response, database = self._call(blocks[:2], blocks)
        assert response.status == 400
        assert not any("SET position" in statement for statement in database.statements)

    def test_the_whole_page_is_accepted(self):
        blocks = ["b" * 18, "c" * 18, "d" * 18]
        response, database = self._call([blocks[2], blocks[0], blocks[1]], blocks)
        assert response.status == 200
        positions = [bindings[1] for statement, bindings in database.writes if "SET position" in statement]
        assert positions == [0, 1, 2]
