"""The three routes behind the release list.

Reading is separate from refreshing on purpose, and that separation is the only
interesting thing here: a GET must never list the bucket, because a listing costs
money and this page is opened by whoever happens to be looking. So refreshing is
a POST — it spends something and rewrites the record — and the delete is checked
again on this side, since the page's disabled button is a courtesy rather than
the rule.
"""

import asyncio
import types

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}
INSTALLER = "luma-video-uploader-0.1.0-setup.exe"
NOW = 1785292800

RECORDED = {
    "FROM desktop_releases": [
        {"file": INSTALLER, "version": "0.1.0", "byte_size": 900, "uploaded_at": NOW, "refreshed_at": NOW},
    ],
    "FROM desktop_version_policy": [
        {"latest": "0.9.0", "min_supported": "0.9.0", "force_update": 0, "blocked": 0,
         "notes": "", "updated_at": NOW},
    ],
}


class Tools:
    """A bucket that says what it was asked, so "did this cost money" is visible."""

    def __init__(self, keys=()):
        self.keys = list(keys)
        self.listed = 0
        self.deleted: list[str] = []

    async def list(self, **_options):
        self.listed += 1
        return types.SimpleNamespace(
            objects=[
                types.SimpleNamespace(key=key, size=10, uploaded=None) for key in self.keys
            ],
            truncated=False,
            cursor=None,
        )

    async def delete(self, key):
        self.deleted.append(key)


@pytest.fixture
def call():
    import admin_main
    from shared import migrations

    def run(request, answers=None, tools=None, database=None):
        migrations._applied_names = None
        worker = admin_main.Default()
        worker.env = make_env(
            database if database is not None else FakeDatabase({**SIGNED_IN, **(answers or {})}),
            origins=ADMIN_ORIGIN,
            frontend=ADMIN_ORIGIN,
            DESKTOP_TOOLS=tools,
        )
        return asyncio.run(worker.fetch(request))

    return run


def signed_in(path: str, method: str = "GET"):
    return FakeRequest(
        path,
        method,
        {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
        host=ADMIN_HOST,
    )


class TestReadingTheList:
    def test_opening_the_page_does_not_list_the_bucket(self, call):
        """The reason the button exists. A GET that listed R2 would be a page
        costing money every time somebody clicked through the back office."""

        tools = Tools([f"releases/{INSTALLER}"])

        response = call(signed_in("/api/desktop/releases"), RECORDED, tools=tools)

        assert response.status == 200
        assert tools.listed == 0
        assert response.json()["versions"][0]["version"] == "0.1.0"

    def test_the_tool_may_not_read_it(self, call):
        """A paired uploader has no business knowing what else was published,
        and certainly no business deleting any of it."""

        from domain import desktop_auth

        assert desktop_auth.scope_allows("video", "GET", "/api/desktop/releases") is False
        assert desktop_auth.scope_allows("video", "DELETE", "/api/desktop/releases/0.1.0") is False


class TestRefreshingTheList:
    def test_it_lists_the_bucket_when_asked_to(self, call):
        tools = Tools([f"releases/{INSTALLER}", "releases/latest.yml"])

        response = call(signed_in("/api/desktop/releases/refresh", "POST"), tools=tools)

        assert response.status == 200
        assert tools.listed == 1
        assert response.json()["hasFeed"] is True

    def test_a_deployment_with_no_bucket_says_so(self, call):
        """503, not an empty list. An unconfigured deployment and an empty
        bucket read identically, and only one of them is fixed by uploading
        something."""

        assert call(signed_in("/api/desktop/releases/refresh", "POST"), tools=None).status == 503


class TestDeletingAVersion:
    def test_it_deletes_the_version(self, call):
        tools = Tools()

        response = call(signed_in(f"/api/desktop/releases/0.1.0", "DELETE"), RECORDED, tools=tools)

        assert response.status == 200
        assert tools.deleted == [f"releases/{INSTALLER}"]

    def test_the_published_version_is_refused_here_too(self, call):
        """409 rather than a disabled button. The page disables it as well, but
        a page is what somebody sees and this is what actually happens."""

        answers = {**RECORDED, "FROM desktop_version_policy": [
            {"latest": "0.1.0", "min_supported": "0.0.1", "force_update": 0, "blocked": 0,
             "notes": "", "updated_at": NOW},
        ]}
        tools = Tools()

        response = call(signed_in("/api/desktop/releases/0.1.0", "DELETE"), answers, tools=tools)

        assert response.status == 409
        assert tools.deleted == []

    def test_a_version_with_no_record_is_a_404(self, call):
        response = call(signed_in("/api/desktop/releases/7.7.7", "DELETE"), RECORDED, tools=Tools())

        assert response.status == 404

    def test_something_that_is_not_a_version_is_refused(self, call):
        """The path segment is whatever was typed into the address bar."""

        response = call(signed_in("/api/desktop/releases/latest.yml", "DELETE"), RECORDED, tools=Tools())

        assert response.status == 409
