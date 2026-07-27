"""The routing table, the CSRF gate and the rate limits, exercised end to end.

Only the pure functions were covered before, so a wrong branch order or a
missing guard would have reached production the way the frontend's redirect
did. D1 and R2 are replaced, because a fake of those tests the fake — but
which path reaches which handler, and what an unauthenticated caller gets
back, is exactly what belongs here.
"""

import asyncio
import types

import pytest


ORIGIN = "https://luma-studio.tw"


class FakeStatement:
    def __init__(self, sql: str, rows_for):
        self.sql = sql
        self._rows_for = rows_for
        self.bindings: tuple = ()

    def bind(self, *values):
        self.bindings = values
        return self

    async def run(self):
        return types.SimpleNamespace(success=True)

    async def all(self):
        return types.SimpleNamespace(results=self._rows_for(self.sql, self.bindings))


class FakeDatabase:
    """Answers with whatever the test declared for a matching statement."""

    def __init__(self, answers: dict[str, list] | None = None):
        self.answers = answers or {}
        self.statements: list[str] = []

    def prepare(self, sql: str):
        self.statements.append(" ".join(sql.split()))
        return FakeStatement(sql, self._rows_for)

    def _rows_for(self, sql: str, _bindings):
        for fragment, rows in self.answers.items():
            if fragment in " ".join(sql.split()):
                return rows
        return []


class FakeBucket:
    def __init__(self, objects: dict | None = None):
        self.objects = objects or {}

    async def get(self, key):
        return self.objects.get(key)


class FakeHeaders:
    def __init__(self, values: dict):
        self._values = {key.lower(): value for key, value in values.items()}

    def get(self, name):
        return self._values.get(name.lower())


class FakeRequest:
    def __init__(self, path: str, method: str = "GET", headers: dict | None = None):
        self.url = f"https://api.luma-studio.tw{path}"
        self.method = method
        self.headers = FakeHeaders(headers or {})
        self.cf = None


class DenyingLimiter:
    async def limit(self, _options):
        return types.SimpleNamespace(success=False)


def make_env(database=None, bucket=None, **extra):
    return types.SimpleNamespace(
        DB=database or FakeDatabase(),
        IBON_IMAGES=bucket or FakeBucket(),
        ALLOWED_ORIGINS=f"{ORIGIN},https://www.luma-studio.tw",
        FRONTEND_ORIGIN=ORIGIN,
        **extra,
    )


@pytest.fixture
def call():
    """Run one request through the Worker's entry point."""

    import main
    import migrations

    def run(request, env=None):
        # Each test starts from a database that has not been migrated yet.
        migrations._applied_names = None
        worker = main.Default()
        worker.env = env or make_env()
        return asyncio.run(worker.fetch(request))

    return run


def browser(path: str, method: str = "GET", **headers):
    """A request shaped the way the frontend sends them."""

    base = {"Origin": ORIGIN, "x-luma-app": "1"}
    base.update(headers)
    return FakeRequest(path, method, base)


class TestCrossOriginGate:
    def test_preflight_is_answered_before_anything_else(self, call):
        response = call(FakeRequest("/api/admin/folders", "OPTIONS", {"Origin": ORIGIN}))
        assert response.status == 204
        assert response.headers["access-control-allow-origin"] == ORIGIN
        assert "x-luma-app" in response.headers["access-control-allow-headers"]

    def test_a_write_without_the_app_header_is_refused(self, call):
        """A plain HTML form cannot set a custom header, which is the point."""

        response = call(FakeRequest("/auth/logout", "POST", {"Origin": ORIGIN}))
        assert response.status == 403

    def test_a_write_from_an_unlisted_origin_is_refused(self, call):
        response = call(FakeRequest("/auth/logout", "POST", {"Origin": "https://evil.example", "x-luma-app": "1"}))
        assert response.status == 403

    def test_reads_are_not_gated(self, call):
        assert call(FakeRequest("/api/health")).status == 200

    def test_cors_headers_only_go_to_listed_origins(self, call):
        allowed = call(FakeRequest("/api/health", headers={"Origin": ORIGIN}))
        assert allowed.headers["access-control-allow-origin"] == ORIGIN

        stranger = call(FakeRequest("/api/health", headers={"Origin": "https://evil.example"}))
        assert "access-control-allow-origin" not in stranger.headers
        assert stranger.headers["vary"] == "Origin"


class TestAuthentication:
    def test_session_without_a_cookie_is_unauthorised(self, call):
        assert call(browser("/api/session")).status == 401

    def test_admin_endpoints_are_closed(self, call):
        assert call(browser("/api/admin/folders")).status == 401
        assert call(browser("/api/admin/bio-link")).status == 401

    def test_a_shaped_but_unknown_cookie_is_still_unauthorised(self, call):
        request = browser("/api/session", Cookie="luma_admin_session=" + "a" * 40)
        assert call(request).status == 401

    def test_no_cookie_means_no_session_lookup(self, call):
        """Rejecting on shape alone keeps an unauthenticated flood off D1.

        The migrations create the table, so this looks for the read rather
        than for any mention of it.
        """

        database = FakeDatabase()
        call(browser("/api/session"), make_env(database))
        lookups = [s for s in database.statements if s.startswith("SELECT email FROM admin_sessions")]
        assert lookups == []

    def test_a_shaped_cookie_does_reach_the_database(self, call):
        """The opposite case, so the test above cannot pass by accident."""

        database = FakeDatabase()
        call(browser("/api/session", Cookie="luma_admin_session=" + "a" * 40), make_env(database))
        lookups = [s for s in database.statements if s.startswith("SELECT email FROM admin_sessions")]
        assert len(lookups) == 1


class TestRoutingTable:
    def test_health_reports_the_applied_migrations(self, call):
        body = call(FakeRequest("/api/health")).json()
        assert body["ok"] is True
        assert "0005_create_bio_link" in body["migrations"]

    def test_unknown_paths_are_not_found(self, call):
        assert call(FakeRequest("/nope")).status == 404

    def test_admin_is_redirected_to_the_frontend(self, call):
        response = call(FakeRequest("/admin"))
        assert response.status == 302
        assert response.headers["location"] == f"{ORIGIN}/admin"

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


class TestDatabaseDependence:
    def test_serving_an_object_does_not_need_the_database(self):
        import main

        assert main.needs_database("/images/a/b.jpg") is False
        assert main.needs_database("/bio-link-assets/a.jpg") is False
        assert main.needs_database("/api/bio-link") is True

    def test_a_broken_migration_stops_the_request(self, call, monkeypatch):
        import main
        from common import MigrationError

        async def explode(_env):
            raise MigrationError("0005_create_bio_link")

        monkeypatch.setattr(main, "apply_migrations", explode)
        response = call(FakeRequest("/api/bio-link"))
        assert response.status == 503
        assert response.json()["migration"] == "0005_create_bio_link"


class TestRateLimits:
    def test_a_denied_caller_gets_429_with_retry_after(self, call):
        env = make_env(PUBLIC_LIMITER=DenyingLimiter())
        response = call(FakeRequest("/api/bio-link", headers={"CF-Connecting-IP": "203.0.113.7"}), env)
        assert response.status == 429
        assert response.headers["retry-after"] == "60"

    def test_login_is_limited_separately(self, call):
        env = make_env(LOGIN_LIMITER=DenyingLimiter())
        response = call(FakeRequest("/auth/login", headers={"CF-Connecting-IP": "203.0.113.7"}), env)
        assert response.status == 429

    def test_a_missing_binding_lets_the_request_through(self, call):
        """A limiter that can take the site down is worse than the abuse."""

        response = call(FakeRequest("/api/bio-link", headers={"CF-Connecting-IP": "203.0.113.7"}))
        assert response.status == 200
