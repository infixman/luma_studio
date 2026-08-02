"""The script behind the two editor tasks that flip production's test payment.

Small, and worth pinning anyway: it edits the file that decides whether anybody
can pay for nothing. The failure worth guarding is the quiet one — a rewrite
that matches no line, changes nothing, and then reports a successful deploy of
the setting it did not change.
"""

import importlib.util
import pathlib

import pytest


MODULE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "fake_payment.py"

_spec = importlib.util.spec_from_file_location("fake_payment", MODULE)
fake_payment = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fake_payment)


CONFIG = '''[vars]
# Turn it off before opening: ALLOW_FAKE_PAYMENT = "1" means free checkout.
ALLOW_FAKE_PAYMENT = "1"
COURSE_CHECKOUT_ENABLED = "1"
'''


def test_turning_it_off_changes_that_line_and_nothing_else():
    changed = fake_payment.set_flag(CONFIG, "0")

    assert 'ALLOW_FAKE_PAYMENT = "0"' in changed
    # The comment above it quotes the setting, as comments about settings do.
    # An unanchored pattern rewrites that too, and the file starts explaining
    # the opposite of what it does.
    assert 'ALLOW_FAKE_PAYMENT = "1" means free checkout' in changed
    # The course flags are a different decision and must survive this one.
    assert 'COURSE_CHECKOUT_ENABLED = "1"' in changed
    assert changed.count("\n") == CONFIG.count("\n")


def test_turning_it_on_is_the_same_edit_the_other_way():
    assert 'ALLOW_FAKE_PAYMENT = "1"' in fake_payment.set_flag(CONFIG.replace('"1"', '"0"', 1), "1")


def test_a_file_without_the_setting_is_a_refusal_rather_than_a_no_op():
    """Otherwise the script deploys, says it worked, and production keeps
    whatever it had — which for this switch is the worst way to be wrong."""

    with pytest.raises(LookupError):
        fake_payment.set_flag('[vars]\nSOMETHING_ELSE = "1"\n', "0")


def test_the_setting_it_edits_is_the_one_the_worker_reads():
    """Named in three places — the config, the script and the route — and the
    route is the one that decides. A rename that missed one of the others would
    leave a switch that flips nothing."""

    checkout = (pathlib.Path(__file__).resolve().parents[1] / "src" / "api" / "front" / "checkout.py").read_text(
        encoding="utf8"
    )

    assert f'"{fake_payment.FLAG}"' in checkout
