"""The routes behind the version policy and the installer.

Two of them are unusual for this Worker and both deliberately so: the policy is
readable by the tool's own token, because "may I work" is a question a tool that
cannot ask has to answer with yes; and the release files are public, because an
updater looks for a new build before anybody has signed into anything.
"""

import asyncio
import types

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}]}


class Tools:
    def __init__(self, objects=None):
        self.objects = objects or {}
        self.asked: list[str] = []

    async def get(self, key):
        self.asked.append(key)
        body = self.objects.get(key)
        return None if body is None else types.SimpleNamespace(body=body)


class JsonRequest(FakeRequest):
    def __init__(self, path: str, method: str, body: dict, headers: dict | None = None):
        super().__init__(path, method, headers, host=ADMIN_HOST)
        self._body = body

    async def json(self):
        return self._body


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


class TestReadingThePolicy:
    def test_it_says_where_the_updater_should_look(self, call):
        """Built from whichever deployment answered. A configured host is wrong
        on the deployment that is not production, and wrong silently — a staging
        build would check the live feed."""

        response = call(signed_in("/api/desktop/version-policy"))

        assert response.json()["feedUrl"] == f"https://{ADMIN_HOST}/releases"

    def test_it_answers_with_the_stored_policy(self, call):
        response = call(
            signed_in("/api/desktop/version-policy"),
            {"FROM desktop_version_policy": [
                {"latest": "1.2.0", "min_supported": "1.0.0", "force_update": 0,
                 "blocked": 0, "notes": "", "updated_at": 5}
            ]},
        )

        assert response.status == 200
        assert response.json()["latest"] == "1.2.0"

    def test_asking_about_a_version_gets_a_verdict(self, call):
        """The tool asks with its own version, so the answer is a decision rather
        than a table it has to interpret — two implementations of "am I too old"
        would eventually disagree."""

        response = call(
            signed_in("/api/desktop/version-policy?version=0.9.0"),
            {"FROM desktop_version_policy": [
                {"latest": "1.2.0", "min_supported": "1.0.0", "force_update": 0,
                 "blocked": 0, "notes": "", "updated_at": 5}
            ]},
        )

        assert response.json()["verdict"]["allowed"] is False

    def test_the_tool_may_ask(self, call):
        """Its token reaches this route. A tool that cannot ask has to assume the
        answer is yes, which is what the policy exists to prevent."""

        from domain import desktop_auth

        assert desktop_auth.scope_allows("video", "GET", "/api/desktop/version-policy") is True

    def test_the_tool_may_not_change_it(self, call):
        from domain import desktop_auth

        assert desktop_auth.scope_allows("video", "PUT", "/api/desktop/version-policy") is False


class TestWritingThePolicy:
    def _put(self, call, body, database=None):
        return call(
            JsonRequest(
                "/api/desktop/version-policy",
                "PUT",
                body,
                {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
            ),
            database=database,
        )

    def test_an_admin_can_change_it(self, call):
        response = self._put(call, {"latest": "1.3.0", "minSupported": "1.1.0"})

        assert response.status == 200

    def test_a_minimum_above_the_latest_is_refused(self, call):
        """It would stop every installed tool, including the one about to be
        published, and it is exactly the shape a typo takes."""

        assert self._put(call, {"latest": "1.2.0", "minSupported": "9.9.9"}).status == 400

    def test_something_that_is_not_a_version_is_refused(self, call):
        assert self._put(call, {"latest": "soon", "minSupported": "1.0.0"}).status == 400

    def test_only_a_real_boolean_blocks_every_tool(self, call):
        """`"false"` is truthy in Python, and this is the field that stops every
        installed tool at once.

        Asserted on the INSERT rather than on the row read back: the fake
        database answers reads from what the test declared, so a read-back check
        would pass with anything written.
        """

        database = FakeDatabase(SIGNED_IN)
        self._put(call, {"latest": "1.3.0", "minSupported": "1.1.0", "blocked": "false"}, database)

        written = [
            b for sql, b in database.writes if sql.startswith("INSERT INTO desktop_version_policy")
        ]
        # (latest, min_supported, force_update, blocked, notes, now)
        assert written and written[0][3] == 0


class TestServingARelease:
    def _get(self, call, path, tools=None):
        return call(FakeRequest(path, "GET", {}, host=ADMIN_HOST), tools=tools or Tools())

    def test_the_updater_can_read_the_metadata_without_signing_in(self, call):
        """It looks for a new build before anybody has signed into anything, and
        the two admins are not going to paste a token into a Windows updater."""

        tools = Tools({"releases/latest.yml": b"version: 1.2.0"})

        response = self._get(call, "/releases/latest.yml", tools)

        assert response.status == 200
        assert tools.asked == ["releases/latest.yml"]

    def test_the_installer_is_served_as_bytes(self, call):
        tools = Tools({"releases/luma-video-uploader-1.2.0-setup.exe": b"MZ"})

        response = self._get(call, "/releases/luma-video-uploader-1.2.0-setup.exe", tools)

        assert response.status == 200
        assert response.headers["content-type"] == "application/octet-stream"

    def test_the_metadata_is_not_cached_forever(self, call):
        """`latest.yml` is the file an updater re-reads to discover a new
        version. An immutable one is an update nobody is ever offered."""

        tools = Tools({"releases/latest.yml": b"version: 1.2.0"})

        response = self._get(call, "/releases/latest.yml", tools)

        assert "immutable" not in response.headers["cache-control"]

    def test_the_installer_is_cached_hard(self, call):
        tools = Tools({"releases/luma-video-uploader-1.2.0-setup.exe": b"MZ"})

        response = self._get(call, "/releases/luma-video-uploader-1.2.0-setup.exe", tools)

        assert "immutable" in response.headers["cache-control"]

    @pytest.mark.parametrize(
        "path",
        [
            "/releases/.env",
            "/releases/notes.txt",
            "/releases/../secrets/latest.yml",
            "/releases/1.2.0/sub/dir/latest.yml",
            "/releases/1.2.0/latest.yml",
        ],
    )
    def test_anything_that_is_not_a_release_file_is_not_found(self, call, path):
        assert self._get(call, path).status == 404

    def test_a_deployment_with_no_bucket_says_so(self, call):
        response = call(FakeRequest("/releases/latest.yml", "GET", {}, host=ADMIN_HOST), tools=None)

        assert response.status == 503
