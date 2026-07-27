"""Who gets limited, and what happens when the limiter itself misbehaves."""

import types

import pytest


@pytest.fixture
def rate_limit():
    import rate_limit as module

    return module


class FakeHeaders:
    def __init__(self, values: dict):
        self._values = values

    def get(self, name):
        return self._values.get(name)


class FakeRequest:
    def __init__(self, ip: str | None = None):
        self.headers = FakeHeaders({"CF-Connecting-IP": ip} if ip else {})


class FakeLimiter:
    """Stands in for the Workers rate limit binding."""

    def __init__(self, success: bool = True, raises: bool = False):
        self.success = success
        self.raises = raises
        self.keys: list[str] = []

    async def limit(self, options):
        if self.raises:
            raise RuntimeError("limiter unavailable")
        self.keys.append(options["key"])
        return types.SimpleNamespace(success=self.success)


def env_with(limiter=None, name="PUBLIC_LIMITER"):
    return types.SimpleNamespace(**({name: limiter} if limiter is not None else {}))


class TestClientKey:
    def test_scopes_the_key_so_budgets_do_not_share(self, rate_limit):
        request = FakeRequest("203.0.113.7")
        assert rate_limit.client_key(request, "login") == "login:203.0.113.7"
        assert rate_limit.client_key(request, "print") == "print:203.0.113.7"

    def test_is_empty_without_a_trustworthy_address(self, rate_limit):
        """CF-Connecting-IP is set by Cloudflare and cannot be spoofed.

        With nothing to key on, one caller must not be able to consume
        everyone else's budget.
        """

        assert rate_limit.client_key(FakeRequest(), "login") == ""


def run(coroutine):
    """Drive a coroutine to completion without an async test plugin."""

    try:
        coroutine.send(None)
    except StopIteration as stop:
        return stop.value
    raise AssertionError("coroutine awaited something real")


class TestAllowsBehaviour:
    def test_passes_when_the_limiter_says_yes(self, rate_limit):
        limiter = FakeLimiter(success=True)
        allowed = run(rate_limit.allows(env_with(limiter), "PUBLIC_LIMITER", FakeRequest("203.0.113.7"), "bio"))
        assert allowed is True
        assert limiter.keys == ["bio:203.0.113.7"]

    def test_blocks_when_the_limiter_says_no(self, rate_limit):
        limiter = FakeLimiter(success=False)
        allowed = run(rate_limit.allows(env_with(limiter), "PUBLIC_LIMITER", FakeRequest("203.0.113.7"), "bio"))
        assert allowed is False

    def test_allows_when_the_binding_is_absent(self, rate_limit):
        """A deploy without the binding must still serve traffic."""

        allowed = run(rate_limit.allows(env_with(None), "PUBLIC_LIMITER", FakeRequest("203.0.113.7"), "bio"))
        assert allowed is True

    def test_allows_when_the_limiter_raises(self, rate_limit):
        """A limiter that can take the site down is worse than the abuse."""

        limiter = FakeLimiter(raises=True)
        allowed = run(rate_limit.allows(env_with(limiter), "PUBLIC_LIMITER", FakeRequest("203.0.113.7"), "bio"))
        assert allowed is True

    def test_allows_when_there_is_no_address_to_key_on(self, rate_limit):
        limiter = FakeLimiter(success=False)
        allowed = run(rate_limit.allows(env_with(limiter), "PUBLIC_LIMITER", FakeRequest(), "bio"))
        assert allowed is True
        assert limiter.keys == []


def test_every_binding_name_is_configured(rate_limit):
    """The names in code must match the [[ratelimits]] blocks in wrangler.toml."""

    from pathlib import Path

    config = (Path(__file__).resolve().parents[1] / "wrangler.toml").read_text(encoding="utf-8")
    for name in (rate_limit.LOGIN, rate_limit.PRINT, rate_limit.PUBLIC):
        assert f'name = "{name}"' in config, f"{name} has no [[ratelimits]] block"


def test_namespace_ids_are_unique():
    """Two limiters sharing a namespace would share one budget."""

    import re
    from pathlib import Path

    config = (Path(__file__).resolve().parents[1] / "wrangler.toml").read_text(encoding="utf-8")
    ids = re.findall(r'namespace_id = "(\d+)"', config)
    assert len(ids) == len(set(ids)), f"duplicate rate limit namespace_id: {ids}"


def test_periods_are_supported_values():
    """Cloudflare accepts only 10 or 60 seconds; anything else fails to deploy."""

    import re
    from pathlib import Path

    config = (Path(__file__).resolve().parents[1] / "wrangler.toml").read_text(encoding="utf-8")
    for period in re.findall(r"period = (\d+)", config):
        assert period in {"10", "60"}, f"unsupported rate limit period: {period}"
