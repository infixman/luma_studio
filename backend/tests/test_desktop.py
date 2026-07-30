"""Pairing a desktop tool with the back office.

The seed is not stored. It is derived from a Worker secret and the admin's
email, which is what makes this table-free: there is nothing to migrate,
nothing to show once and hope was written down, and a D1 dump reveals no seeds
because there are none in it.
"""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


ADMIN_HOST = "admin-api.luma-studio.tw"
OWNER = "chiao7912@gmail.com"
SIGNED_IN = {"SELECT email FROM admin_sessions": [{"email": OWNER}]}
PAIRING_SECRET = "a-worker-secret-nobody-else-has"


@pytest.fixture
def desktop_auth():
    from domain import desktop_auth as module

    return module


def env_with(**extra):
    return make_env(
        FakeDatabase(SIGNED_IN),
        origins=ADMIN_ORIGIN,
        frontend=ADMIN_ORIGIN,
        DESKTOP_PAIRING_SECRET=PAIRING_SECRET,
        **extra,
    )


class TestTheDerivedSeed:
    def test_each_admin_gets_a_different_one(self, desktop_auth):
        """Otherwise one leaked code would authorise a machine as anybody."""

        env = env_with()

        assert desktop_auth.seed_for(env, OWNER) != desktop_auth.seed_for(env, "infixman@gmail.com")

    def test_the_same_admin_gets_the_same_one_every_time(self, desktop_auth):
        """It has to survive an isolate being replaced between showing a code
        and verifying it."""

        env = env_with()

        assert desktop_auth.seed_for(env, OWNER) == desktop_auth.seed_for(env, OWNER)

    def test_case_and_spacing_do_not_change_it(self, desktop_auth):
        """The session stores a lowercased address; a caller might not send
        one, and two seeds for one person means codes that never match."""

        env = env_with()

        assert desktop_auth.seed_for(env, "  ChIao7912@Gmail.com ") == desktop_auth.seed_for(env, OWNER)

    def test_rotating_the_secret_changes_every_seed(self, desktop_auth):
        """This is the revocation mechanism: no table to clear, one value to
        change, and every paired machine has to pair again."""

        before = desktop_auth.seed_for(env_with(), OWNER)
        after = desktop_auth.seed_for(
            make_env(FakeDatabase(SIGNED_IN), DESKTOP_PAIRING_SECRET="something-else"), OWNER
        )

        assert before != after

    def test_without_a_secret_it_refuses_rather_than_deriving_from_nothing(self, desktop_auth):
        """An empty secret derives a seed anybody could compute."""

        from shared.common import NotConfigured

        with pytest.raises(NotConfigured):
            desktop_auth.seed_for(make_env(FakeDatabase(SIGNED_IN)), OWNER)

    def test_the_secret_is_not_recoverable_from_the_seed(self, desktop_auth):
        seed = desktop_auth.seed_for(env_with(), OWNER)

        assert PAIRING_SECRET not in seed


class TestVerifyingAPairing:
    def test_the_code_on_screen_is_the_code_that_works(self, desktop_auth):
        env, now = env_with(), 1785292800

        shown = desktop_auth.pairing_code(env, OWNER, now=now)["code"]

        assert desktop_auth.verify_pairing(env, OWNER, shown, now=now) is True

    def test_another_admins_code_does_not_work(self, desktop_auth):
        env, now = env_with(), 1785292800

        other = desktop_auth.pairing_code(env, "infixman@gmail.com", now=now)["code"]

        assert desktop_auth.verify_pairing(env, OWNER, other, now=now) is False

    def test_somebody_who_is_not_an_admin_cannot_pair(self, desktop_auth):
        """The exchange is unauthenticated, so this is where the allowlist is
        applied. Deriving a seed for an arbitrary address would hand out a
        working code to anybody who asked."""

        env, now = env_with(), 1785292800

        assert desktop_auth.verify_pairing(env, "stranger@example.com", "000000", now=now) is False

    def test_a_stale_code_does_not_work(self, desktop_auth):
        env, now = env_with(), 1785292800

        stale = desktop_auth.pairing_code(env, OWNER, now=now - 120)["code"]

        assert desktop_auth.verify_pairing(env, OWNER, stale, now=now) is False

    def test_an_unconfigured_worker_refuses_instead_of_raising(self, desktop_auth):
        """The exchange is reachable without a session. A missing secret must
        be a refusal there, not a 500 that says the Worker is misconfigured."""

        bare = make_env(FakeDatabase(SIGNED_IN))

        assert desktop_auth.verify_pairing(bare, OWNER, "000000", now=1785292800) is False


class TestThePairingCodeRoute:
    @pytest.fixture
    def call(self):
        import admin_main
        from shared import migrations

        # `None` means "the usual configuration"; `{}` means a Worker with none.
        # Falling back on a falsy value would make the second one untestable.
        def run(request, env=None, answers=None):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({**SIGNED_IN, **(answers or {})}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
                **({"DESKTOP_PAIRING_SECRET": PAIRING_SECRET} if env is None else env),
            )
            return asyncio.run(worker.fetch(request))

        return run

    def _request(self, headers: dict | None = None):
        base = {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40}
        base.update(headers or {})
        return FakeRequest("/api/desktop/pairing-code", "GET", base, host=ADMIN_HOST)

    def test_it_shows_a_code_and_how_long_is_left(self, call):
        response = call(self._request())

        body = response.json()
        assert response.status == 200
        assert len(body["code"]) == 6 and body["code"].isdigit()
        assert 1 <= body["expiresInSeconds"] <= 30

    def test_it_names_the_admin_the_code_belongs_to(self, call):
        """The tool asks for an email as well as a code, and a code that is
        right for the wrong address just fails with no explanation."""

        assert call(self._request()).json()["adminEmail"] == OWNER

    def test_an_anonymous_caller_gets_no_code(self, call):
        """The whole scheme rests on this: a code is only visible to somebody
        already signed in, which is what makes showing one an authorisation."""

        response = call(FakeRequest(
            "/api/desktop/pairing-code", "GET",
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host=ADMIN_HOST,
        ))

        assert response.status == 401

    def test_an_unconfigured_worker_says_so(self, call):
        response = call(self._request(), env={})

        assert response.status == 503

    def test_the_secret_never_reaches_the_response(self, call):
        response = call(self._request())

        assert PAIRING_SECRET not in response.body

    def test_the_seed_never_reaches_the_response(self, call):
        """It is the long-lived credential. The code is the disposable one."""

        from domain import desktop_auth

        seed = desktop_auth.seed_for(env_with(), OWNER)

        assert seed not in call(self._request()).body
