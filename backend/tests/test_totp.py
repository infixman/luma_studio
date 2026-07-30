"""The pairing code, checked against the RFC's own numbers and a real library.

This is not a second password. The server both shows the code and verifies it,
so what it buys is a time bound without storing state: a code is good for one
window and then it is not, which is what makes "being able to see the back
office" the same thing as "being able to authorise one machine".

RFC 6238 with SHA-1 rather than something stronger, and a base32 seed, because
that is what authenticator apps read. Nothing needs that today — the code comes
from an admin page — but it costs nothing and keeps the option of skipping the
page later.

pyotp is a test-only oracle. It does not exist in the Workers runtime and must
never be imported by anything under `src/`.
"""

import sys, pathlib

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))

from shared import totp


# RFC 6238 Appendix B: the ASCII secret "12345678901234567890", base32-encoded.
RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


class TestAgainstTheRfc:
    """Appendix B of RFC 6238, for the SHA-1 rows."""

    @pytest.mark.parametrize(
        "instant,expected",
        [
            (59, "287082"),
            (1111111109, "081804"),
            (1111111111, "050471"),
            (1234567890, "005924"),
            (2000000000, "279037"),
        ],
    )
    def test_the_published_values_come_out(self, instant, expected):
        assert totp.code_at(RFC_SECRET, instant) == expected


class TestAgainstALibrary:
    """Same seed, same instant, same six digits."""

    @pytest.mark.parametrize("instant", [0, 59, 1785292800, 1785292829, 1785292830, 2000000000])
    def test_it_agrees_with_pyotp(self, instant):
        import pyotp

        secret = totp.new_secret()

        assert totp.code_at(secret, instant) == pyotp.TOTP(secret).at(instant)

    def test_a_generated_secret_is_something_an_authenticator_can_read(self):
        """Base32, no padding, and long enough. A seed a standard app refuses
        would close off ever provisioning one."""

        import pyotp

        secret = totp.new_secret()

        assert len(secret) >= 32
        assert "=" not in secret
        assert pyotp.TOTP(secret).at(0)


class TestTheWindow:
    def test_a_code_holds_for_its_whole_step(self, ):
        first = totp.code_at(RFC_SECRET, 1785292800)

        assert totp.code_at(RFC_SECRET, 1785292800 + totp.STEP - 1) == first

    def test_the_next_step_is_a_different_code(self):
        assert totp.code_at(RFC_SECRET, 1785292800) != totp.code_at(RFC_SECRET, 1785292830)

    def test_it_says_how_long_is_left(self):
        """The page shows this. Somebody typing a code with two seconds left
        would otherwise be told their correct code was wrong."""

        assert totp.seconds_left(1785292800) == totp.STEP
        assert totp.seconds_left(1785292829) == 1


class TestVerifying:
    def test_the_current_code_is_accepted(self):
        now = 1785292800

        assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, now), now=now) is True

    def test_the_previous_window_is_accepted(self):
        """Clock skew between a laptop and a Worker is not a wrong answer, and
        neither is somebody typing six digits slowly."""

        now = 1785292800

        assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, now - totp.STEP), now=now) is True

    def test_the_window_before_that_is_not(self):
        now = 1785292800

        assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, now - 2 * totp.STEP), now=now) is False

    def test_a_future_window_is_not_accepted(self):
        """Skew is symmetrical in principle, but accepting the next code widens
        the guessing window for nothing — the admin is reading the same clock."""

        now = 1785292800

        assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, now + totp.STEP), now=now) is False

    @pytest.mark.parametrize("submitted", ["", "12345", "1234567", "abcdef", None, 123456, "12 34 56"])
    def test_anything_that_is_not_six_digits_is_refused(self, submitted):
        assert totp.verify(RFC_SECRET, submitted, now=1785292800) is False

    @pytest.mark.parametrize("submitted", ["１２３４５６", "١٢٣٤٥٦", "１23456"])
    def test_digits_that_are_not_ascii_are_refused_and_not_a_crash(self, submitted):
        """`"１２３４５６".isdigit()` is true, and `compare_digest` raises on a
        non-ASCII string rather than returning False — so a length-and-isdigit
        check alone turns six full-width digits into a 500."""

        assert totp.verify(RFC_SECRET, submitted, now=1785292800) is False

    def test_a_missing_seed_refuses_everything(self):
        """An admin with no seed must not be authorisable by any code, and least
        of all by an empty one."""

        assert totp.verify("", "000000", now=1785292800) is False
        assert totp.verify(None, "000000", now=1785292800) is False

    def test_a_malformed_seed_refuses_rather_than_raises(self):
        """It is read from a database. A row that got corrupted should refuse
        logins, not turn every request into a 500."""

        assert totp.verify("not base32!!", "000000", now=1785292800) is False

    def test_the_comparison_does_not_stop_at_the_first_wrong_digit(self):
        """Six digits is 10^6 guesses, so leaking how much of one was right
        makes the attempt limit the only thing standing there."""

        import inspect

        assert "compare_digest" in inspect.getsource(totp)
