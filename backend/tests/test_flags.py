"""Switches for things that are built but not yet safe to sell.

The point of these is that the server decides. A flag the client reads is a
flag an attacker reads too, and "the button was hidden" has never stopped
anybody from calling the endpoint underneath it.
"""

import pytest

from conftest import make_env


@pytest.fixture
def flags():
    from shared import flags as module

    return module


class TestReadingAFlag:
    def test_a_flag_set_to_one_is_on(self, flags):
        assert flags.enabled(make_env(None, COURSE_CHECKOUT_ENABLED="1"), flags.COURSE_CHECKOUT) is True

    def test_everything_else_is_off(self, flags):
        for value in ("0", "", "true", "yes", "TRUE"):
            env = make_env(None, COURSE_CHECKOUT_ENABLED=value)
            assert flags.enabled(env, flags.COURSE_CHECKOUT) is False

    def test_a_flag_nobody_set_is_off(self, flags):
        """Unset means off, so a new deployment sells nothing by accident."""

        assert flags.enabled(make_env(None), flags.COURSE_CHECKOUT) is False

    def test_only_the_exact_string_counts(self, flags):
        """"true" reads as on to a human and is a typo to this. Accepting it
        would mean two spellings, and eventually a third that does not work."""

        assert flags.enabled(make_env(None, COURSE_CHECKOUT_ENABLED="true"), flags.COURSE_CHECKOUT) is False
