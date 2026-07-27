"""The bio link page's validation and classification rules."""

import pytest


class TestValidateUrl:
    """The one function between an admin's typing and a Location header."""

    @pytest.mark.parametrize(
        "value",
        [
            "https://example.com/a?b=1",
            "http://example.com",
            "mailto:hello@example.com",
            "tel:+886912345678",
        ],
    )
    def test_accepts_the_allowed_schemes(self, bio_link, value):
        assert bio_link.validate_url(value) == value

    @pytest.mark.parametrize(
        "value",
        [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "blob:https://example.com/x",
            "//evil.example",
            "example.com",
        ],
    )
    def test_rejects_everything_else(self, bio_link, value):
        with pytest.raises(ValueError):
            bio_link.validate_url(value)

    @pytest.mark.parametrize(
        "value",
        [
            "https://a.example/x\r\nSet-Cookie: sid=1",
            "https://a.example/x\nX-Injected: 1",
            "https://a.example/x\ty",
            "https://a.example/\x00x",
            "https://a.example/\x7f",
        ],
    )
    def test_rejects_control_characters(self, bio_link, value):
        """urlsplit strips these before parsing, so they must not survive.

        Validating one string and storing another is how a CRLF reaches a
        response header.
        """

        with pytest.raises(ValueError):
            bio_link.validate_url(value)

    def test_requires_a_host_for_web_schemes(self, bio_link):
        with pytest.raises(ValueError):
            bio_link.validate_url("https:evil.example")

    def test_trims_surrounding_whitespace(self, bio_link):
        assert bio_link.validate_url("  https://example.com  ") == "https://example.com"

    def test_rejects_empty_and_overlong(self, bio_link):
        with pytest.raises(ValueError):
            bio_link.validate_url("")
        with pytest.raises(ValueError):
            bio_link.validate_url("https://example.com/" + "a" * bio_link.MAX_URL_LENGTH)


class TestValidateText:
    def test_trims_and_returns(self, bio_link):
        assert bio_link.validate_text("  hi  ", 10, "Title") == "hi"

    def test_requires_a_value_by_default(self, bio_link):
        with pytest.raises(ValueError):
            bio_link.validate_text("   ", 10, "Title")

    def test_allows_empty_when_optional(self, bio_link):
        assert bio_link.validate_text("   ", 10, "Bio", required=False) == ""

    def test_enforces_the_limit(self, bio_link):
        assert bio_link.validate_text("a" * 10, 10, "Title") == "a" * 10
        with pytest.raises(ValueError):
            bio_link.validate_text("a" * 11, 10, "Title")


class TestKindAndPlatform:
    def test_accepts_the_two_kinds(self, bio_link):
        assert bio_link.validate_kind("link") == "link"
        assert bio_link.validate_kind("social") == "social"

    def test_rejects_anything_else(self, bio_link):
        with pytest.raises(ValueError):
            bio_link.validate_kind("button")

    def test_platform_only_applies_to_socials(self, bio_link):
        assert bio_link.validate_platform("link", "instagram") is None
        assert bio_link.validate_platform("social", "instagram") == "instagram"

    def test_rejects_an_unknown_platform(self, bio_link):
        with pytest.raises(ValueError):
            bio_link.validate_platform("social", "myspace")
        with pytest.raises(ValueError):
            bio_link.validate_platform("social", None)


class TestItemId:
    def test_accepts_generated_ids(self, bio_link):
        assert bio_link.validate_item_id("abcDEF123_-xyz") == "abcDEF123_-xyz"

    @pytest.mark.parametrize("value", ["short", "has spaces", "../../etc", "a" * 61, ""])
    def test_rejects_malformed_ids(self, bio_link, value):
        with pytest.raises(ValueError):
            bio_link.validate_item_id(value)


class TestAvatarPaths:
    def test_maps_a_stored_key_to_a_public_path(self, bio_link):
        key = f"{bio_link.AVATAR_PREFIX}/token.jpg"
        assert bio_link.avatar_path(key) == f"{bio_link.AVATAR_URL_PREFIX}/token.jpg"

    def test_returns_none_for_anything_unrecognised(self, bio_link):
        assert bio_link.avatar_path(None) is None
        assert bio_link.avatar_path("") is None
        assert bio_link.avatar_path("20260721_soda/photo.jpg") is None

    def test_generated_keys_sit_under_the_private_prefix(self, bio_link):
        """The prefix must stay outside the ibon folder pattern.

        A key that matched it would list as a print folder and be reachable
        through /images/.
        """

        key = bio_link.avatar_key(".png")
        assert key.startswith(f"{bio_link.AVATAR_PREFIX}/")
        assert key.endswith(".png")
        assert bio_link.avatar_path(key) is not None


class TestVisitorClassification:
    @pytest.mark.parametrize(
        "agent,expected",
        [
            ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148", "mobile"),
            ("Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36", "mobile"),
            ("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "tablet"),
            ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150", "desktop"),
        ],
    )
    def test_device_classes(self, bio_link, agent, expected):
        assert bio_link.device_from_user_agent(agent) == expected

    @pytest.mark.parametrize(
        "agent",
        [
            "",
            "Googlebot/2.1",
            "facebookexternalhit/1.1",
            "WhatsApp/2.23",
            "TelegramBot (like TwitterBot)",
            "Mozilla/5.0 (compatible; Discordbot/2.0)",
            "curl/8.21.0",
            "python-requests/2.31.0",
        ],
    )
    def test_recognises_bots_and_unfurlers(self, bio_link, agent):
        """Link previewers fetch on every share and would inflate the counts."""

        assert bio_link.looks_like_bot(agent) is True

    def test_leaves_real_browsers_alone(self, bio_link):
        assert bio_link.looks_like_bot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150 Safari/537.36") is False

    @pytest.mark.parametrize(
        "referer,expected",
        [
            ("https://www.instagram.com/some/path", "www.instagram.com"),
            ("http://EXAMPLE.com:8080/x", "example.com"),
            ("", None),
            ("not a url", None),
        ],
    )
    def test_referrer_host(self, bio_link, referer, expected):
        assert bio_link.referrer_host(referer) == expected


class TestStatsWindow:
    @pytest.mark.parametrize("days", [1, 7, 30, 90])
    def test_window_is_inclusive_of_both_ends(self, bio_link, common, days):
        from datetime import datetime

        start = datetime.strptime(bio_link._window_start(days), "%Y-%m-%d")
        today = datetime.strptime(common.taipei_day(), "%Y-%m-%d")
        assert (today - start).days + 1 == days
