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
ASSET_ID = "asset-000001"


class JsonRequest(FakeRequest):
    def __init__(self, path: str, method: str, body: dict, headers: dict | None = None):
        super().__init__(
            path, method,
            headers or {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"},
            host=ADMIN_HOST,
        )
        self._body = body

    async def json(self):
        return self._body


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


TOKEN_SECRET = "another-worker-secret"


def paired_env(**extra):
    return make_env(
        FakeDatabase(SIGNED_IN),
        origins=ADMIN_ORIGIN,
        frontend=ADMIN_ORIGIN,
        DESKTOP_PAIRING_SECRET=PAIRING_SECRET,
        DESKTOP_TOKEN_SECRET=TOKEN_SECRET,
        **extra,
    )


class TestExchangingACodeForAToken:
    """Reached without a session, which is what makes it the exposed surface.

    Six digits is a million guesses. Nothing here relies on the code being hard
    to find — it relies on a code being spendable once, and on an account being
    locked after a handful of wrong ones.
    """

    def _spend(self, desktop_auth, env, *, code=None, now=1785292800, email=OWNER):
        if code is None:
            code = desktop_auth.pairing_code(env, email, now=now)["code"]
        return asyncio.run(desktop_auth.exchange(env, email=email, code=code, now=now))

    def test_the_right_code_yields_a_token(self, desktop_auth):
        env = paired_env()

        granted = self._spend(desktop_auth, env)

        assert granted["token"]
        assert granted["scope"] == "video"
        assert granted["adminEmail"] == OWNER
        assert granted["expiresAt"] > 1785292800

    def test_the_token_reads_back_as_this_admin(self, desktop_auth):
        env = paired_env()

        granted = self._spend(desktop_auth, env)
        claim = desktop_auth.read_token(env, granted["token"], now=1785292800)

        assert claim["adminEmail"] == OWNER
        assert claim["scope"] == "video"

    def test_a_wrong_code_yields_nothing(self, desktop_auth):
        env = paired_env()

        assert self._spend(desktop_auth, env, code="000000") is None

    def test_a_code_cannot_be_spent_twice(self, desktop_auth):
        """Its window is thirty seconds and it is visible on a screen. Without
        this, one glance at the page is repeatable for half a minute."""

        env = paired_env()
        code = desktop_auth.pairing_code(env, OWNER, now=1785292800)["code"]

        first = self._spend(desktop_auth, env, code=code)
        env.DB.answers = {
            **SIGNED_IN,
            "SELECT * FROM desktop_pairings": [
                {"email": OWNER, "used_counter": 1785292800 // 30, "failures": 0,
                 "locked_until": 0, "updated_at": 0}
            ],
        }
        second = self._spend(desktop_auth, env, code=code)

        assert first is not None
        assert second is None

    def test_an_older_window_cannot_be_replayed_after_a_newer_one(self, desktop_auth):
        """Accepting the previous window is for clock skew, not for going
        backwards past a code that has already been spent."""

        env = paired_env()
        env.DB.answers = {
            **SIGNED_IN,
            "SELECT * FROM desktop_pairings": [
                {"email": OWNER, "used_counter": 1785292800 // 30, "failures": 0,
                 "locked_until": 0, "updated_at": 0}
            ],
        }
        earlier = desktop_auth.pairing_code(env, OWNER, now=1785292800 - 30)["code"]

        assert self._spend(desktop_auth, env, code=earlier) is None

    def test_too_many_wrong_codes_locks_the_account(self, desktop_auth):
        env = paired_env()
        env.DB.answers = {
            **SIGNED_IN,
            "SELECT * FROM desktop_pairings": [
                {"email": OWNER, "used_counter": None,
                 "failures": desktop_auth.MAX_FAILURES, "locked_until": 1785292800 + 60,
                 "updated_at": 0}
            ],
        }

        # Even the correct code, because the lock is on the account and not on
        # the guess.
        assert self._spend(desktop_auth, env) is None

    def test_a_lock_expires(self, desktop_auth):
        env = paired_env()
        env.DB.answers = {
            **SIGNED_IN,
            "SELECT * FROM desktop_pairings": [
                {"email": OWNER, "used_counter": None,
                 "failures": desktop_auth.MAX_FAILURES, "locked_until": 1785292800 - 1,
                 "updated_at": 0}
            ],
        }

        assert self._spend(desktop_auth, env) is not None

    def test_a_wrong_code_is_recorded(self, desktop_auth):
        """The limit is only real if failures are counted."""

        env = paired_env()

        self._spend(desktop_auth, env, code="000000")

        assert any("desktop_pairings" in statement for statement, _ in env.DB.writes)

    def test_somebody_who_is_not_an_admin_gets_nothing(self, desktop_auth):
        env = paired_env()

        assert self._spend(desktop_auth, env, email="stranger@example.com", code="000000") is None

    def test_without_a_token_secret_nothing_is_issued(self, desktop_auth):
        """An unsigned token that looks signed is worse than a refusal."""

        env = make_env(
            FakeDatabase(SIGNED_IN),
            DESKTOP_PAIRING_SECRET=PAIRING_SECRET,
        )
        code = desktop_auth.pairing_code(env, OWNER, now=1785292800)["code"]

        assert asyncio.run(
            desktop_auth.exchange(env, email=OWNER, code=code, now=1785292800)
        ) is None


class TestWhatAVideoTokenMayReach:
    """The token is not an admin session, and this is where that is true.

    A tool that can create an asset and ask for upload URLs is the whole
    requirement. Anything beyond it — orders, customers, entitlements — is a
    403: the identity is real, the permission is not.
    """

    @pytest.mark.parametrize(
        "method,path",
        [
            ("POST", "/api/video-assets"),
            ("POST", "/api/video-assets/asset-1/upload-urls"),
            ("POST", "/api/video-assets/import"),
        ],
    )
    def test_the_upload_routes_are_reachable(self, desktop_auth, method, path):
        assert desktop_auth.scope_allows("video", method, path) is True

    @pytest.mark.parametrize(
        "method,path",
        [
            ("GET", "/api/orders"),
            ("POST", "/api/orders/order-1/advance"),
            ("GET", "/api/customers"),
            ("POST", "/api/courses"),
            ("GET", "/api/session"),
            ("GET", "/api/dashboard"),
            ("POST", "/api/entitlements/e1/revoke"),
            ("GET", "/api/desktop/pairing-code"),
        ],
    )
    def test_everything_else_is_not(self, desktop_auth, method, path):
        assert desktop_auth.scope_allows("video", method, path) is False

    def test_reading_the_library_is_not_part_of_uploading(self, desktop_auth):
        """Listing is how you find out what other people uploaded. The tool
        knows the asset it just created."""

        assert desktop_auth.scope_allows("video", "GET", "/api/video-assets") is False

    def test_archiving_is_not_either(self, desktop_auth):
        """Deletion and archiving live in the back office, where the reference
        checks are."""

        assert desktop_auth.scope_allows("video", "POST", "/api/video-assets/asset-1/archive") is False

    def test_abandoning_an_upload_is_not_either(self, desktop_auth):
        """Same reason as archiving: it retires an asset, and what a lesson still
        points at is known in the back office."""

        assert desktop_auth.scope_allows("video", "POST", "/api/video-assets/asset-1/abort") is False

    def test_an_unknown_scope_reaches_nothing(self, desktop_auth):
        """Not a default. A new scope has to say what it opens."""

        assert desktop_auth.scope_allows("everything", "POST", "/api/video-assets") is False

    def test_a_near_miss_path_is_not_matched_by_prefix(self, desktop_auth):
        assert desktop_auth.scope_allows("video", "POST", "/api/video-assets-evil") is False


class TestTheExchangeRoute:
    @pytest.fixture
    def call(self):
        import admin_main
        from shared import migrations

        def run(body, env=None, answers=None):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({**SIGNED_IN, **(answers or {})}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
                **({"DESKTOP_PAIRING_SECRET": PAIRING_SECRET,
                    "DESKTOP_TOKEN_SECRET": TOKEN_SECRET} if env is None else env),
            )
            request = JsonRequest("/api/desktop/tokens", "POST", body)
            return asyncio.run(worker.fetch(request))

        return run

    def test_it_needs_no_session(self, call, desktop_auth):
        """A tool has none. If this needed one there would be nothing to pair."""

        from shared.common import utc_timestamp

        # The route reads the clock, so the code has to be for now rather than
        # for a fixed instant.
        code = desktop_auth.pairing_code(paired_env(), OWNER, now=utc_timestamp())["code"]

        response = call({"email": OWNER, "code": code})

        assert response.status == 200
        assert response.json()["scope"] == "video"

    def test_a_wrong_code_is_refused_without_saying_why(self, call):
        """"Not an admin", "wrong code" and "locked" are one answer. The
        difference belongs in a log."""

        response = call({"email": OWNER, "code": "000000"})

        assert response.status == 401
        assert "lock" not in response.body.lower()

    def test_a_malformed_body_is_refused(self, call):
        assert call({}).status == 401

    def test_the_pairing_secret_never_reaches_the_response(self, call, desktop_auth):
        from shared.common import utc_timestamp

        code = desktop_auth.pairing_code(paired_env(), OWNER, now=utc_timestamp())["code"]

        body = call({"email": OWNER, "code": code}).body

        assert PAIRING_SECRET not in body
        assert TOKEN_SECRET not in body


class TestPairedToolEndToEnd:
    """The acceptance test for the whole scheme.

    A tool with no session pairs, and then the token it got is worth exactly
    the upload routes and nothing else. Every part of this is checked
    individually elsewhere; this is here because the parts are in three
    different modules and the gate that joins them is one `if`.
    """

    R2 = {
        "R2_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com",
        "R2_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
        "R2_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "COURSE_SOURCE_BUCKET": "luma-course-source",
        "COURSE_VIDEO_BUCKET": "luma-course-video",
        "VIDEO_UPLOAD_ENABLED": "1",
        "DESKTOP_PAIRING_SECRET": PAIRING_SECRET,
        "DESKTOP_TOKEN_SECRET": TOKEN_SECRET,
    }

    @pytest.fixture
    def worker(self):
        import admin_main
        from shared import migrations

        def run(request, answers=None):
            migrations._applied_names = None
            instance = admin_main.Default()
            # No admin_sessions row on purpose: the tool has no session, and a
            # test that quietly had one would prove nothing about the token.
            instance.env = make_env(
                FakeDatabase(answers or {}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
                **self.R2,
            )
            return asyncio.run(instance.fetch(request))

        return run

    def _pair(self, worker) -> str:
        from domain import desktop_auth
        from shared.common import utc_timestamp

        code = desktop_auth.pairing_code(paired_env(), OWNER, now=utc_timestamp())["code"]
        response = worker(JsonRequest("/api/desktop/tokens", "POST", {"email": OWNER, "code": code}))

        assert response.status == 200, response.body
        return response.json()["token"]

    def _with_token(self, path: str, method: str, body: dict, token: str) -> JsonRequest:
        return JsonRequest(
            path, method, body,
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Authorization": f"Bearer {token}"},
        )

    def test_a_paired_tool_can_create_an_asset(self, worker):
        token = self._pair(worker)

        response = worker(
            self._with_token("/api/video-assets", "POST", {"title": "第一課", "byteSize": 1_000_000}, token)
        )

        assert response.status == 201

    def test_a_paired_tool_can_get_upload_urls(self, worker):
        token = self._pair(worker)
        uploading = {
            "SELECT * FROM video_assets": [{
                "id": ASSET_ID, "title": "第一課", "original_filename": "a.mp4",
                "source_key": "", "status": "uploading", "byte_size": 1,
                "duration_seconds": None, "width": None, "height": None,
                "active_encode_version": None, "master_key": None, "poster_key": None,
                "error_code": None, "error_detail": None, "created_at": 0, "updated_at": 0,
            }]
        }

        response = worker(
            self._with_token(
                f"/api/video-assets/{ASSET_ID}/upload-urls", "POST",
                {"kind": "output", "keys": [f"videos/{ASSET_ID}/1/master.m3u8"]}, token,
            ),
            answers=uploading,
        )

        assert response.status == 200
        assert "X-Amz-Signature=" in response.json()["urls"][0]["url"]

    @pytest.mark.parametrize(
        "method,path",
        [
            ("GET", "/api/orders"),
            ("GET", "/api/customers"),
            ("GET", "/api/dashboard"),
            ("GET", "/api/session"),
            ("POST", "/api/courses"),
            ("GET", "/api/video-assets"),
            ("POST", f"/api/video-assets/{ASSET_ID}/archive"),
            ("GET", "/api/desktop/pairing-code"),
        ],
    )
    def test_the_same_token_reaches_nothing_else(self, worker, method, path):
        """The point of the scope. Losing the tool must not be losing the shop."""

        token = self._pair(worker)

        response = worker(self._with_token(path, method, {}, token))

        assert response.status == 403

    def test_a_forged_token_is_not_admitted(self, worker):
        response = worker(
            self._with_token("/api/video-assets", "POST", {"title": "x", "byteSize": 1}, "dv1.x.y")
        )

        assert response.status == 401

    def test_a_playback_token_is_not_a_desktop_token(self, worker):
        """Different prefix and different secret, so it is refused before any
        comparison — but worth pinning, because both are HMAC bearer tokens
        built by the same code."""

        from domain import playback
        from shared.common import utc_timestamp

        borrowed = playback.issue(
            {"assetId": "asset-1", "encodeVersion": 1}, secret=TOKEN_SECRET, now=utc_timestamp()
        )

        response = worker(
            self._with_token("/api/video-assets", "POST", {"title": "x", "byteSize": 1}, borrowed)
        )

        assert response.status == 401

    def test_a_spent_code_does_not_pair_a_second_machine(self, worker):
        from domain import desktop_auth
        from shared.common import utc_timestamp

        now = utc_timestamp()
        code = desktop_auth.pairing_code(paired_env(), OWNER, now=now)["code"]

        first = worker(JsonRequest("/api/desktop/tokens", "POST", {"email": OWNER, "code": code}))
        already_used = {
            "SELECT * FROM desktop_pairings": [
                {"email": OWNER, "used_counter": now // 30, "failures": 0,
                 "locked_until": 0, "updated_at": now}
            ]
        }
        second = worker(
            JsonRequest("/api/desktop/tokens", "POST", {"email": OWNER, "code": code}),
            answers=already_used,
        )

        assert first.status == 200
        assert second.status == 401


class TestReachableBySomethingThatIsNotABrowser:
    """The gap the earlier end-to-end test did not close.

    Those tests built their own requests, and every one of them carried the
    `Origin` and `x-luma-app` headers a browser sends. So they proved the routing
    and the scope while the real tool — which is not a browser and has no
    legitimate origin — could not get past the CSRF gate at all. It failed with
    "Cross-site request rejected", which reads like a pairing problem and is not.

    The gate exists to protect requests authenticated by a *cookie*, because that
    is what a browser attaches on its own. A request carrying a bearer token
    cannot be forged by a cross-site form: setting `Authorization` makes the
    browser preflight, and the preflight advertises only `content-type` and
    `x-luma-app`.
    """

    @pytest.fixture
    def call(self):
        import admin_main
        from shared import migrations

        def run(request, env=None, answers=None):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({**SIGNED_IN, **(answers or {})}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
                **(
                    {"DESKTOP_PAIRING_SECRET": PAIRING_SECRET, "DESKTOP_TOKEN_SECRET": TOKEN_SECRET}
                    if env is None
                    else env
                ),
            )
            return asyncio.run(worker.fetch(request))

        return run

    def _token(self) -> str:
        from shared.common import utc_timestamp

        env, now = paired_env(), utc_timestamp()
        code = desktop_auth_module().pairing_code(env, OWNER, now=now)["code"]
        granted = asyncio.run(desktop_auth_module().exchange(env, email=OWNER, code=code, now=now))
        return granted["token"]

    def test_a_tool_can_exchange_a_code_with_no_browser_headers(self, call):
        """It has no session and no origin — that is what pairing is for."""

        from shared.common import utc_timestamp

        code = desktop_auth_module().pairing_code(paired_env(), OWNER, now=utc_timestamp())["code"]
        request = JsonRequest("/api/desktop/tokens", "POST", {"email": OWNER, "code": code}, {})

        response = call(request)

        assert response.status == 200, response.body

    def test_a_bearer_token_reaches_an_upload_route_with_no_browser_headers(self, call):
        request = JsonRequest(
            "/api/video-assets", "POST",
            {"title": "第一課", "byteSize": 1_000_000},
            {"Authorization": f"Bearer {self._token()}"},
        )

        response = call(
            request,
            env={
                "DESKTOP_PAIRING_SECRET": PAIRING_SECRET,
                "DESKTOP_TOKEN_SECRET": TOKEN_SECRET,
                "VIDEO_UPLOAD_ENABLED": "1",
            },
        )

        assert response.status == 201, response.body

    def test_a_cookie_write_with_no_app_header_is_still_rejected(self, call):
        """The property that must not regress. A cross-site form can make a
        browser send a cookie; it cannot make it send this header."""

        request = JsonRequest(
            "/api/courses", "POST", {"slug": "x", "title": "x"},
            {"Origin": ADMIN_ORIGIN, "Cookie": "luma_admin_session=" + "a" * 40},
        )

        assert call(request).status == 403

    def test_a_cookie_write_from_another_origin_is_still_rejected(self, call):
        request = JsonRequest(
            "/api/courses", "POST", {"slug": "x", "title": "x"},
            {"Origin": "https://evil.example", "x-luma-app": "1",
             "Cookie": "luma_admin_session=" + "a" * 40},
        )

        assert call(request).status == 403

    def test_a_bearer_that_is_not_ours_still_gets_nowhere(self, call):
        """Exempting the gate is not admitting the request — the token is still
        verified, and a wrong one is a 401."""

        request = JsonRequest(
            "/api/video-assets", "POST", {"title": "x", "byteSize": 1},
            {"Authorization": "Bearer dv1.nonsense.signature"},
        )

        assert call(request).status == 401


def desktop_auth_module():
    from domain import desktop_auth

    return desktop_auth
