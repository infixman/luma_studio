"""Site chrome settings and the three-level menu."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def site_chrome():
    from domain import site_chrome as module

    return module


def item(item_id, parent=None, label="項目", kind="url", target="https://example.com"):
    return {"id": item_id, "parentId": parent, "label": label, "targetKind": kind, "target": target, "position": 0}


class TestModuleName:
    def test_it_is_not_called_site(self, site_chrome):
        """`site` is a standard library module Python imports at start-up.

        `import site` resolves to that one whatever is on the path, so this
        module cannot be named that — the failure is confusing enough to be
        worth a test that names the reason.
        """

        assert site_chrome.__name__ == "domain.site_chrome"


class TestAppearanceIsChosenNotTyped:
    @pytest.mark.parametrize(
        "field,value",
        [
            ("headerBackground", "gradient"),
            ("headerColour", "#ff00ff"),
            ("headerHeight", "137px"),
            ("headerText", "grey"),
            ("headerLogoSize", "huge"),
            ("footerColour", "rgb(0,0,0)"),
        ],
    )
    def test_a_value_outside_the_fixed_set_is_refused(self, site_chrome, field, value):
        """Nothing the owner enters becomes CSS. That is the whole rule."""

        body = {
            "headerBackground": "solid",
            "headerColour": "cream",
            "headerHeight": "medium",
            "headerText": "dark",
            "headerLogoSize": "medium",
            "footerColour": "ink",
            "footerText": "light",
            **{field: value},
        }
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.validate_settings(body)

    def test_a_valid_combination_is_accepted(self, site_chrome):
        fields = site_chrome.validate_settings(
            {
                "headerBackground": "image",
                "headerColour": "sand",
                "headerHeight": "large",
                "headerText": "light",
                "headerLogoSize": "small",
                "headerSticky": False,
                "footerColour": "forest",
                "footerText": "light",
                "footerCopyright": "© 苒光繪誌",
            }
        )
        assert fields["header_background"] == "image"
        assert fields["header_sticky"] == 0
        assert fields["footer_copyright"] == "© 苒光繪誌"


class TestFooterBlurb:
    """The sentence under the mark in the footer's brand column."""

    def test_it_is_saved_with_the_rest_of_the_chrome(self, site_chrome):
        fields = site_chrome.validate_settings(
            {
                "headerBackground": "solid",
                "headerColour": "cream",
                "headerHeight": "medium",
                "headerText": "dark",
                "headerLogoSize": "medium",
                "footerColour": "ink",
                "footerText": "light",
                "footerBlurb": "  台中的插畫工作室，畫紙上的光。  ",
            }
        )
        assert fields["footer_blurb"] == "台中的插畫工作室，畫紙上的光。"

    def test_empty_is_a_real_answer(self, site_chrome):
        """A shop with nothing to add gets a mark and a copyright line."""

        fields = site_chrome.validate_settings(
            {
                "headerBackground": "solid",
                "headerColour": "cream",
                "headerHeight": "medium",
                "headerText": "dark",
                "headerLogoSize": "medium",
                "footerColour": "ink",
                "footerText": "light",
            }
        )
        assert fields["footer_blurb"] == ""

    def test_a_blurb_longer_than_the_limit_is_refused(self, site_chrome):
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.validate_settings(
                {
                    "headerBackground": "solid",
                    "headerColour": "cream",
                    "headerHeight": "medium",
                    "headerText": "dark",
                    "headerLogoSize": "medium",
                    "footerColour": "ink",
                    "footerText": "light",
                    "footerBlurb": "字" * (site_chrome.MAX_BLURB + 1),
                }
            )

    def test_a_row_from_before_the_migration_still_maps(self, site_chrome):
        """Both Workers read this table and only one of them applies schema.

        An empty blurb is a footer without a sentence; a KeyError here is a
        site without a footer.
        """

        row = {
            "header_background": "solid",
            "header_colour": "cream",
            "header_image_key": None,
            "header_height": "medium",
            "header_text": "dark",
            "header_logo_size": "medium",
            "header_sticky": 1,
            "header_show_cart": 1,
            "header_show_login": 1,
            "header_cta_label": "",
            "header_cta_url": "",
            "footer_colour": "ink",
            "footer_text": "light",
            "footer_copyright": "",
            "footer_columns": "[]",
            "footer_socials": "[]",
        }
        assert site_chrome.settings_row(row)["footerBlurb"] == ""


class TestFooterStructure:
    def test_columns_and_links_round_trip(self, site_chrome):
        columns = site_chrome.validate_footer_columns(
            [{"title": "客服", "links": [{"label": "服務條款", "url": "https://luma-studio.tw/terms"}]}]
        )
        assert columns[0]["title"] == "客服"
        assert columns[0]["links"][0]["label"] == "服務條款"

    def test_an_unknown_social_platform_is_refused(self, site_chrome):
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.validate_footer_socials([{"platform": "myspace", "url": "https://example.com"}])

    def test_a_javascript_url_is_refused(self, site_chrome):
        with pytest.raises(ValueError):
            site_chrome.validate_footer_columns(
                [{"title": "x", "links": [{"label": "點我", "url": "javascript:alert(1)"}]}]
            )

    def test_too_many_columns_is_refused(self, site_chrome):
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.validate_footer_columns([{"title": "x", "links": []}] * 5)

    def test_stored_json_that_no_longer_fits_reads_as_empty(self, site_chrome):
        """A footer missing its links still lets every page render.

        Raising here would take the whole site down over one bad column.
        """

        row = {
            "header_background": "solid",
            "header_colour": "cream",
            "header_image_key": None,
            "header_height": "medium",
            "header_text": "dark",
            "header_logo_size": "medium",
            "header_sticky": 1,
            "header_show_cart": 1,
            "header_show_login": 1,
            "header_cta_label": "",
            "header_cta_url": "",
            "footer_colour": "ink",
            "footer_text": "light",
            "footer_copyright": "",
            "footer_columns": "not json at all",
            "footer_socials": json.dumps([{"platform": "myspace", "url": "https://x"}]),
        }
        settings = site_chrome.settings_row(row)
        assert settings["footerColumns"] == []
        assert settings["footerSocials"] == []


class TestMenuDepth:
    def test_the_top_level_is_depth_one(self, site_chrome):
        assert site_chrome.depth_of([], None) == 1

    def test_depth_counts_the_ancestors(self, site_chrome):
        items = [item("a"), item("b", parent="a"), item("c", parent="b")]
        assert site_chrome.depth_of(items, "a") == 2
        assert site_chrome.depth_of(items, "b") == 3
        # A fourth level is what the API refuses; the counting itself is fine.
        assert site_chrome.depth_of(items, "c") == 4

    def test_a_missing_parent_is_refused(self, site_chrome):
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.depth_of([], "ghost")

    def test_a_cycle_is_refused_rather_than_counted_forever(self, site_chrome):
        """Not reachable through the API, but a hand-edited row could do it."""

        items = [item("a", parent="b"), item("b", parent="a")]
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.depth_of(items, "a")


class TestMenuTargets:
    def test_a_page_target_is_kept_as_an_id(self, site_chrome):
        """Storing the id rather than the URL is what keeps the menu working
        when a page's path is renamed."""

        fields = site_chrome.validate_menu_fields({"label": "關於", "targetKind": "page", "target": "pg123"})
        assert fields["target"] == "pg123"

    def test_an_external_url_is_validated(self, site_chrome):
        with pytest.raises(ValueError):
            site_chrome.validate_menu_fields({"label": "x", "targetKind": "url", "target": "javascript:alert(1)"})

    def test_an_empty_target_is_refused(self, site_chrome):
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.validate_menu_fields({"label": "x", "targetKind": "page", "target": ""})

    def test_an_unknown_kind_is_refused(self, site_chrome):
        with pytest.raises(site_chrome.ChromeError):
            site_chrome.validate_menu_fields({"label": "x", "targetKind": "magic", "target": "y"})


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


class TestPublicSite:
    def test_the_chrome_is_public(self, call):
        response = call(FakeRequest("/api/site"))
        assert response.status == 200
        body = response.json()
        assert body["settings"]["headerBackground"] == "solid"
        assert body["menu"] == []

    def test_an_item_pointing_at_a_missing_page_is_withheld(self, call):
        """A menu entry leading to a 404 is worse than one fewer entry."""

        database = FakeDatabase(
            {
                "FROM menu_items": [
                    {"id": "m1", "parent_id": None, "label": "關於", "target_kind": "page", "target": "gone", "position": 0}
                ]
            }
        )
        assert call(FakeRequest("/api/site"), database).json()["menu"] == []

    def test_an_external_link_survives(self, call):
        database = FakeDatabase(
            {
                "FROM menu_items": [
                    {
                        "id": "m1",
                        "parent_id": None,
                        "label": "IG",
                        "target_kind": "url",
                        "target": "https://instagram.com/x",
                        "position": 0,
                    }
                ]
            }
        )
        menu = call(FakeRequest("/api/site"), database).json()["menu"]
        assert menu[0]["href"] == "https://instagram.com/x"

    def test_a_category_combination_needs_every_part_to_exist(self, call):
        """Dropping the half that vanished would quietly change what it shows."""

        database = FakeDatabase(
            {
                "FROM menu_items": [
                    {
                        "id": "m1",
                        "parent_id": None,
                        "label": "組合",
                        "target_kind": "category",
                        "target": "a,b",
                        "position": 0,
                    }
                ],
                "FROM product_categories ORDER BY": [
                    {"id": "c1", "slug": "a", "title": "A", "description": "", "position": 0}
                ],
            }
        )
        assert call(FakeRequest("/api/site"), database).json()["menu"] == []


class TestAdminSite:
    @pytest.fixture
    def admin_call(self):
        import admin_main
        import migrations

        def run(request):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}),
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

    def test_settings_are_reachable(self, admin_call):
        assert admin_call(self.signed_in("/api/site")).status == 200

    def test_the_menu_is_reachable(self, admin_call):
        assert admin_call(self.signed_in("/api/menu")).status == 200

    def test_reorder_is_not_read_as_a_menu_id(self, admin_call):
        assert admin_call(self.signed_in("/api/menu/order", "PUT")).status == 400

    def test_an_unknown_item_is_reported_as_missing(self, admin_call):
        assert admin_call(self.signed_in("/api/menu/" + "a" * 18, "DELETE")).status == 404

    def test_the_chrome_is_closed_without_a_session(self, admin_call):
        anonymous = FakeRequest(
            "/api/site", "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host="admin-api.luma-studio.tw"
        )
        assert admin_call(anonymous).status == 401
