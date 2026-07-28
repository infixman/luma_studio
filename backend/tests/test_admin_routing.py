"""The admin Worker's routing table, sign-in gate and schema ownership.

The point of this deployment is that its session cookie cannot be reached
from the storefront, and that every route on it is administration. Both of
those are properties of the routing table, so they are asserted here rather
than trusted to hold.
"""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, DenyingLimiter, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"


def admin_env(database=None, **extra):
    google = {
        "GOOGLE_CLIENT_ID": "test-client-id",
        "GOOGLE_CLIENT_SECRET": "test-client-secret",
        "GOOGLE_OAUTH_REDIRECT_URI": f"https://{ADMIN_HOST}/auth/callback",
    }
    google.update(extra)
    return make_env(database, origins=ADMIN_ORIGIN, frontend=ADMIN_ORIGIN, **google)


@pytest.fixture
def call():
    """Run one request through the admin Worker's entry point."""

    import admin_main
    import migrations

    def run(request, env=None):
        # Each test starts from a database that has not been migrated yet.
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = env or admin_env()
        return asyncio.run(worker.fetch(request))

    return run


def browser(path: str, method: str = "GET", **headers):
    """A request shaped the way the back office sends them."""

    base = {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}
    base.update(headers)
    return FakeRequest(path, method, base, host=ADMIN_HOST)


class TestCrossOriginGate:
    def test_preflight_is_answered_before_anything_else(self, call):
        response = call(FakeRequest("/api/folders", "OPTIONS", {"Origin": ADMIN_ORIGIN}, host=ADMIN_HOST))
        assert response.status == 204
        assert response.headers["access-control-allow-origin"] == ADMIN_ORIGIN

    def test_a_write_without_the_app_header_is_refused(self, call):
        response = call(FakeRequest("/auth/logout", "POST", {"Origin": ADMIN_ORIGIN}, host=ADMIN_HOST))
        assert response.status == 403

    def test_the_storefront_origin_is_not_trusted_here(self, call):
        """A page served to customers must not be able to write to the back office."""

        request = FakeRequest(
            "/auth/logout", "POST", {"Origin": "https://luma-studio.tw", "x-luma-app": "1"}, host=ADMIN_HOST
        )
        assert call(request).status == 403


class TestEverythingIsAdministration:
    """Authentication is one gate near the top, so nothing can forget it."""

    @pytest.mark.parametrize(
        "path",
        ["/api/session", "/api/folders", "/api/print-settings", "/api/objects", "/api/bio-link", "/api/anything-new"],
    )
    def test_endpoints_are_closed_without_a_session(self, call, path):
        assert call(browser(path)).status == 401

    def test_a_shaped_but_unknown_cookie_is_still_unauthorised(self, call):
        request = browser("/api/session", Cookie="luma_admin_session=" + "a" * 40)
        assert call(request).status == 401

    def test_no_cookie_means_no_session_lookup(self, call):
        """Rejecting on shape alone keeps an unauthenticated flood off D1."""

        database = FakeDatabase()
        call(browser("/api/session"), admin_env(database))
        lookups = [s for s in database.statements if s.startswith("SELECT email FROM admin_sessions")]
        assert lookups == []

    def test_a_shaped_cookie_does_reach_the_database(self, call):
        """The opposite case, so the test above cannot pass by accident."""

        database = FakeDatabase()
        call(browser("/api/session", Cookie="luma_admin_session=" + "a" * 40), admin_env(database))
        lookups = [s for s in database.statements if s.startswith("SELECT email FROM admin_sessions")]
        assert len(lookups) == 1

    def test_an_unknown_bio_link_path_is_not_found_rather_than_blank(self, call):
        """Falling off the end of the handler used to return no response at all."""

        signed_in = FakeDatabase({"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]})
        request = browser("/api/bio-link/nope", Cookie="luma_admin_session=" + "a" * 40)
        assert call(request, admin_env(signed_in)).status == 404


class TestSchemaOwnership:
    def test_health_applies_the_migrations(self, call):
        body = call(FakeRequest("/api/health", host=ADMIN_HOST)).json()
        assert body["ok"] is True
        assert "0005_create_bio_link" in body["migrations"]

    def test_a_broken_migration_stops_the_request(self, call, monkeypatch):
        import router
        from common import MigrationError

        async def explode(_env):
            raise MigrationError("0005_create_bio_link")

        monkeypatch.setattr(router, "apply_migrations", explode)
        response = call(browser("/api/session"))
        assert response.status == 503
        assert response.json()["migration"] == "0005_create_bio_link"


class TestRateLimits:
    def test_login_is_limited(self, call):
        env = admin_env(LOGIN_LIMITER=DenyingLimiter())
        response = call(FakeRequest("/auth/login", headers={"CF-Connecting-IP": "203.0.113.7"}, host=ADMIN_HOST), env)
        assert response.status == 429

    def test_a_missing_binding_lets_the_request_through(self, call):
        """The owner being unable to sign in is worse than an unthrottled attempt."""

        response = call(FakeRequest("/auth/login", headers={"CF-Connecting-IP": "203.0.113.7"}, host=ADMIN_HOST))
        assert response.status == 302


class TestConfigurationFailures:
    """A deployment missing a secret must say so, not throw.

    An exception escaping a handler becomes Cloudflare's 1101 page, which
    reports only that something went wrong somewhere — the exact shape of the
    bug these two tests exist to prevent recurring.
    """

    def test_signing_in_without_oauth_secrets_names_them(self, call):
        env = make_env(origins=ADMIN_ORIGIN, frontend=ADMIN_ORIGIN)
        response = call(FakeRequest("/auth/login", host=ADMIN_HOST), env)
        assert response.status == 500
        assert "GOOGLE_CLIENT_ID" in response.json()["error"]
        assert "GOOGLE_OAUTH_REDIRECT_URI" in response.json()["error"]

    def test_an_unexpected_failure_answers_rather_than_throws(self, call, monkeypatch):
        import admin_main

        async def explode(_ctx):
            raise RuntimeError("something nobody predicted")

        monkeypatch.setattr(admin_main, "dispatch", explode)
        response = call(FakeRequest("/api/health", host=ADMIN_HOST))
        assert response.status == 500
        body = response.json()
        assert body["error"] == "Unexpected Worker failure"
        # A 1101 does not even say which route was being served.
        assert body["path"] == "/api/health"
