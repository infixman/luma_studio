"""The public Worker's routing table, CSRF gate and rate limits, end to end.

Only the pure functions were covered before, so a wrong branch order or a
missing guard would have reached production the way the frontend's redirect
did. D1 and R2 are replaced, because a fake of those tests the fake — but
which path reaches which handler, and what an unauthenticated caller gets
back, is exactly what belongs here.

Administration is not reachable from this deployment at all. What used to be
asserted here about `/api/admin/*` now lives in test_admin_routing.py.
"""

import asyncio

import pytest

from conftest import STOREFRONT_ORIGIN, DenyingLimiter, FakeDatabase, FakeRequest, make_env


ORIGIN = STOREFRONT_ORIGIN


@pytest.fixture
def call():
    """Run one request through the public Worker's entry point."""

    import main
    import migrations

    def run(request, env=None):
        migrations._applied_names = None
        worker = main.Default()
        worker.env = env or make_env()
        return asyncio.run(worker.fetch(request))

    return run


def browser(path: str, method: str = "GET", **headers):
    """A request shaped the way the storefront sends them."""

    base = {"Origin": ORIGIN, "x-luma-app": "1"}
    base.update(headers)
    return FakeRequest(path, method, base)


class TestCrossOriginGate:
    def test_preflight_is_answered_before_anything_else(self, call):
        response = call(FakeRequest("/api/bio-link", "OPTIONS", {"Origin": ORIGIN}))
        assert response.status == 204
        assert response.headers["access-control-allow-origin"] == ORIGIN
        assert "x-luma-app" in response.headers["access-control-allow-headers"]

    def test_a_write_without_the_app_header_is_refused(self, call):
        """A plain HTML form cannot set a custom header, which is the point."""

        response = call(FakeRequest("/api/bio-link", "POST", {"Origin": ORIGIN}))
        assert response.status == 403

    def test_a_write_from_an_unlisted_origin_is_refused(self, call):
        response = call(FakeRequest("/api/bio-link", "POST", {"Origin": "https://evil.example", "x-luma-app": "1"}))
        assert response.status == 403

    def test_the_admin_origin_is_not_trusted_here(self, call):
        """The back office has its own API; it has no business writing to this one."""

        request = FakeRequest("/api/bio-link", "POST", {"Origin": "https://admin.luma-studio.tw", "x-luma-app": "1"})
        assert call(request).status == 403

    def test_reads_are_not_gated(self, call):
        assert call(FakeRequest("/api/health")).status == 200

    def test_cors_headers_only_go_to_listed_origins(self, call):
        allowed = call(FakeRequest("/api/health", headers={"Origin": ORIGIN}))
        assert allowed.headers["access-control-allow-origin"] == ORIGIN

        stranger = call(FakeRequest("/api/health", headers={"Origin": "https://evil.example"}))
        assert "access-control-allow-origin" not in stranger.headers
        assert stranger.headers["vary"] == "Origin"


class TestAdministrationIsElsewhere:
    """The bridge that carried /api/admin/* through the split is gone.

    404 rather than 401 is the assertion that matters. A 401 would mean the
    handler is still wired up here and only a session check stands between
    the public internet and the back office.
    """

    @pytest.mark.parametrize(
        "path",
        ["/api/admin/folders", "/api/admin/bio-link", "/api/folders", "/api/print-settings", "/api/objects", "/admin"],
    )
    def test_admin_paths_are_not_found(self, call, path):
        assert call(browser(path)).status == 404

    def test_the_customer_session_route_is_not_the_admins(self, call):
        """Same path as the admin host, different meaning, different cookie."""

        database = FakeDatabase()
        assert call(browser("/api/session"), make_env(database)).status == 401
        assert not any("FROM admin_sessions" in statement for statement in database.statements)


class TestHealth:
    def test_health_reports_what_the_database_says_is_applied(self, call):
        database = FakeDatabase({"FROM schema_migrations": [{"name": "0005_create_bio_link"}]})
        body = call(FakeRequest("/api/health"), make_env(database)).json()
        assert body["ok"] is True
        assert body["migrations"] == ["0005_create_bio_link"]

    def test_health_does_not_apply_anything(self, call):
        """Schema changes belong to the admin Worker; this one only reports."""

        database = FakeDatabase()
        call(FakeRequest("/api/health"), make_env(database))
        assert not any("CREATE TABLE" in statement for statement in database.statements)
        assert not any("INSERT" in statement for statement in database.statements)

    def test_a_database_that_cannot_be_read_is_not_fatal(self, call):
        """An empty list is a visible shortfall; a 500 on /api/health is not."""

        class Unreachable:
            def prepare(self, _sql):
                raise RuntimeError("D1 is down")

        body = call(FakeRequest("/api/health"), make_env(Unreachable())).json()
        assert body["migrations"] == []


class TestRoutingTable:
    def test_unknown_paths_are_not_found(self, call):
        assert call(FakeRequest("/nope")).status == 404

    def test_a_shared_print_link_goes_to_the_page(self, call):
        response = call(FakeRequest("/ibon_print/20260721_soda", headers={"Accept": "text/html"}))
        assert response.status == 302
        assert response.headers["location"] == f"{ORIGIN}/ibon_print/20260721_soda"

    def test_a_qr_scanner_without_an_accept_header_also_gets_the_page(self, call):
        """In-app browsers send */*, and they are people, not scripts."""

        response = call(FakeRequest("/ibon_print/20260721_soda", headers={"Accept": "*/*"}))
        assert response.status == 302

    def test_an_invalid_print_id_is_rejected_before_anything_else(self, call):
        assert call(FakeRequest("/ibon_print/../etc")).status == 400
        assert call(FakeRequest("/api/print/../etc")).status == 400

    def test_image_urls_must_have_both_parts(self, call):
        assert call(FakeRequest("/images/onlyfolder")).status == 404

    def test_a_missing_image_is_reported_as_missing(self, call):
        response = call(FakeRequest("/images/20260721_soda/nope.jpg"))
        assert response.status == 404

    def test_an_image_outside_the_folder_pattern_is_refused(self, call):
        # Avatars live under _bio-link/, which this route must never reach.
        assert call(FakeRequest("/images/_bio-link/a.jpg")).status == 400


class TestPublicCatalogue:
    def test_the_index_lists_only_active_products(self, call):
        database = FakeDatabase()
        response = call(FakeRequest("/api/products"), make_env(database))
        assert response.status == 200
        listing = [s for s in database.statements if s.startswith("SELECT * FROM products")]
        assert listing and "status = 'active'" in listing[0]

    def test_a_draft_is_not_reachable_by_guessing_its_slug(self, call):
        database = FakeDatabase(
            {
                "SELECT * FROM products WHERE slug": [
                    {
                        "id": "p1",
                        "slug": "secret-tote",
                        "title": "未上架",
                        "description": "",
                        "status": "draft",
                        "position": 0,
                        "created_at": 1,
                        "updated_at": 1,
                    }
                ]
            }
        )
        assert call(FakeRequest("/api/products/secret-tote"), make_env(database)).status == 404

    def test_an_archived_product_stops_selling(self, call):
        database = FakeDatabase(
            {
                "SELECT * FROM products WHERE slug": [
                    {
                        "id": "p1",
                        "slug": "old-tote",
                        "title": "已下架",
                        "description": "",
                        "status": "archived",
                        "position": 0,
                        "created_at": 1,
                        "updated_at": 1,
                    }
                ]
            }
        )
        assert call(FakeRequest("/api/products/old-tote"), make_env(database)).status == 404

    def test_a_malformed_slug_is_refused_before_the_lookup(self, call):
        database = FakeDatabase()
        assert call(FakeRequest("/api/products/Not_A_Slug")).status == 404
        call(FakeRequest("/api/products/Not_A_Slug"), make_env(database))
        assert not any("FROM products WHERE slug" in s for s in database.statements)

    def test_the_catalogue_is_limited_separately_from_the_bio_link(self, call):
        env = make_env(SHOP_LIMITER=DenyingLimiter())
        response = call(FakeRequest("/api/products", headers={"CF-Connecting-IP": "203.0.113.7"}), env)
        assert response.status == 429


class TestProductPhotos:
    def test_a_photo_no_product_references_is_not_served(self, call):
        """The key comes from the table, not from the URL.

        Serving whatever `_shop/<name>` the caller asks for would turn this
        route into a way to probe the bucket for objects that are no longer
        attached to anything.
        """

        database = FakeDatabase()
        response = call(FakeRequest("/shop-assets/whatever.jpg"), make_env(database))
        assert response.status == 404
        assert any("FROM product_images" in statement for statement in database.statements)

    @pytest.mark.parametrize("name", ["a.gif", "a.svg", "..%2Fa.jpg"])
    def test_a_format_the_shop_does_not_store_is_refused_before_the_lookup(self, call, name):
        database = FakeDatabase()
        response = call(FakeRequest(f"/shop-assets/{name}"), make_env(database))
        assert response.status == 400
        assert not any("FROM product_images" in statement for statement in database.statements)

    def test_only_get_reaches_it(self, call):
        assert call(browser("/shop-assets/a.jpg", "POST")).status == 404


class TestRateLimits:
    def test_a_denied_caller_gets_429_with_retry_after(self, call):
        env = make_env(PUBLIC_LIMITER=DenyingLimiter())
        response = call(FakeRequest("/api/bio-link", headers={"CF-Connecting-IP": "203.0.113.7"}), env)
        assert response.status == 429
        assert response.headers["retry-after"] == "60"

    def test_a_missing_binding_lets_the_request_through(self, call):
        """A limiter that can take the site down is worse than the abuse."""

        response = call(FakeRequest("/api/bio-link", headers={"CF-Connecting-IP": "203.0.113.7"}))
        assert response.status == 200


class TestCalendarIsItsOwnRequest:
    """The schedule costs a fetch to Google; the links must not wait for it."""

    def test_the_page_payload_carries_no_events(self, call, monkeypatch):
        import bio_link

        async def explode(*_args, **_kwargs):
            raise AssertionError("the page response must not fetch the calendar")

        monkeypatch.setattr(bio_link, "fetch_calendar", explode)
        response = call(FakeRequest("/api/bio-link"))

        assert response.status == 200
        body = response.json()
        assert "calendar" not in body
        # Enough for the page to know whether to ask for one.
        assert body["hasCalendar"] is False

    def test_the_schedule_has_its_own_route(self, call, monkeypatch):
        import bio_link

        async def one_event(_env, _settings):
            return {"title": "近期課程", "events": [{"id": "e1", "title": "夏日蘇打大作戰"}]}

        monkeypatch.setattr(bio_link, "fetch_calendar", one_event)
        response = call(FakeRequest("/api/bio-link/calendar"))

        assert response.status == 200
        assert response.json()["calendar"]["events"][0]["id"] == "e1"

    def test_an_unreadable_calendar_is_not_an_error(self, call, monkeypatch):
        # The page is complete without a schedule, so this answers 200 with
        # nothing rather than failing and colouring the whole page red.
        import bio_link

        async def nothing(_env, _settings):
            return None

        monkeypatch.setattr(bio_link, "fetch_calendar", nothing)
        response = call(FakeRequest("/api/bio-link/calendar"))

        assert response.status == 200
        assert response.json()["calendar"] is None

    def test_asking_for_the_schedule_is_not_a_second_visit(self, call, monkeypatch):
        """Otherwise every visit would count twice in the stats."""

        import bio_link

        async def nothing(_env, _settings):
            return None

        async def counted(*_args, **_kwargs):
            raise AssertionError("the calendar route must not record a view")

        monkeypatch.setattr(bio_link, "fetch_calendar", nothing)
        monkeypatch.setattr(bio_link, "record_event", counted)
        assert call(FakeRequest("/api/bio-link/calendar")).status == 200
