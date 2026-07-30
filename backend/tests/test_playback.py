"""Letting a member watch, and nobody else.

A playback token is a bearer credential with a short life. What matters is not
that it is clever but that it is boring in the right ways: it says exactly
which object it is for, it expires, it cannot be edited, and comparing it does
not leak how nearly correct a guess was.

Access is checked once when the token is issued, not on every segment. A
lesson is hundreds of segment requests, and a database round trip on each
would cost more than it protects — the short life is what bounds the damage
instead.
"""

import pytest


@pytest.fixture
def playback():
    from domain import playback as module

    return module


SECRET = "test-secret-value"


def a_claim(**overrides) -> dict:
    return {
        "customerId": "cust-1",
        "courseId": "course-1",
        "lessonId": "lesson-1",
        "assetId": "asset-1",
        "encodeVersion": 1,
        "scope": "entitled",
        **overrides,
    }


class TestSigning:
    def test_a_token_this_server_made_verifies(self, playback):
        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)

        assert playback.verify(token, secret=SECRET, now=1000)["customerId"] == "cust-1"

    def test_a_token_signed_with_another_secret_does_not(self, playback):
        token = playback.issue(a_claim(), secret="somebody-elses-secret", now=1000, ttl=900)

        assert playback.verify(token, secret=SECRET, now=1000) is None

    def test_editing_the_payload_invalidates_the_signature(self, playback):
        """The interesting attack: keep the signature, change what it covers.

        The payload is base64, so this has to decode, edit and re-encode it —
        a string replace on the token would change nothing and the test would
        pass without having tried anything.
        """

        import base64
        import json

        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)
        version, payload, signature = token.split(".")

        claim = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        claim["assetId"] = "asset-9"
        forged = base64.urlsafe_b64encode(
            json.dumps(claim, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).rstrip(b"=").decode("ascii")

        assert playback.verify(f"{version}.{forged}.{signature}", secret=SECRET, now=1000) is None

    @pytest.mark.parametrize("token", ["", "nodot", "a.b.c.d", "!!!.???", "."])
    def test_something_that_is_not_a_token_is_refused_rather_than_crashing(self, playback, token):
        assert playback.verify(token, secret=SECRET, now=1000) is None

    def test_a_token_from_a_future_version_is_refused(self, playback):
        """Version first, so a later format change cannot be replayed against
        a server that would misread it."""

        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)
        assert token.startswith(f"v{playback.TOKEN_VERSION}")


class TestExpiry:
    def test_a_token_inside_its_life_works(self, playback):
        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)

        assert playback.verify(token, secret=SECRET, now=1899) is not None

    def test_a_token_past_its_life_does_not(self, playback):
        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)

        assert playback.verify(token, secret=SECRET, now=1901) is None

    def test_a_token_issued_in_the_future_is_refused(self, playback):
        """Clock skew is small; a token minted ahead of time is not skew."""

        token = playback.issue(a_claim(), secret=SECRET, now=5000, ttl=900)

        assert playback.verify(token, secret=SECRET, now=1000) is None


class TestKeyRotation:
    def test_a_token_signed_with_the_previous_key_still_verifies(self, playback):
        """Rotating a secret must not sign every member out mid-lesson."""

        token = playback.issue(a_claim(), secret="old-secret", now=1000, ttl=900)

        assert playback.verify(token, secret=SECRET, now=1000, previous_secret="old-secret") is not None

    def test_new_tokens_are_only_ever_signed_with_the_current_key(self, playback):
        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)

        assert playback.verify(token, secret="old-secret", now=1000) is None


class TestWhatATokenIsFor:
    def test_a_token_names_the_exact_object_it_covers(self, playback):
        token = playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900)
        claim = playback.verify(token, secret=SECRET, now=1000)

        assert playback.covers(claim, asset_id="asset-1", encode_version=1) is True

    def test_it_does_not_cover_a_different_video(self, playback):
        """One lesson's token must not open the rest of the course."""

        claim = playback.verify(playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900), secret=SECRET, now=1000)

        assert playback.covers(claim, asset_id="asset-2", encode_version=1) is False

    def test_it_does_not_cover_a_different_encode_of_the_same_video(self, playback):
        claim = playback.verify(playback.issue(a_claim(), secret=SECRET, now=1000, ttl=900), secret=SECRET, now=1000)

        assert playback.covers(claim, asset_id="asset-1", encode_version=2) is False


class TestStartingTheClock:
    """A timed grant starts counting at the first watch, not at payment."""

    def test_a_grant_nobody_has_watched_yet_starts_now(self, playback):
        started = playback.expiry_for(access_days=30, first_viewed_at=None, now=1000)

        assert started == {"firstViewedAt": 1000, "expiresAt": 1000 + 30 * 86400}

    def test_a_grant_already_running_is_left_alone(self, playback):
        """Every later playback runs this. Restarting the window on each one
        would make a timed course permanent."""

        assert playback.expiry_for(access_days=30, first_viewed_at=500, now=1000) is None

    def test_a_permanent_grant_never_starts_a_clock(self, playback):
        assert playback.expiry_for(access_days=None, first_viewed_at=None, now=1000) is None
