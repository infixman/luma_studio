"""The five-minute job, and the shape the runtime calls it with.

It had run zero times. `scheduled(self, event)` matched the signature the
runtime used when it was written; the runtime now passes the event, the
environment and the execution context, and every tick since has died with
`TypeError: Default.scheduled() takes 2 positional arguments but 4 were given`
before the first line of the body.

Nothing on screen said so. Unpaid orders stayed unpaid, expired sessions stayed
in the table, and — the one that costs money — queued mail was never sent. The
only trace was one red line every five minutes in a log nobody reads until
something else goes wrong.

So the test calls it the way the platform does, positionally, with everything
the platform passes.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def worker(monkeypatch):
    import main

    done: list[str] = []

    def record(name):
        async def work(_env, *args, **kwargs):
            done.append(name)

        return work

    monkeypatch.setattr(main.orders, "expire_unpaid", record("expire_unpaid"))
    monkeypatch.setattr(main.mail, "send_pending", record("send_pending"))
    monkeypatch.setattr(main.auth_customer, "purge_expired", record("purge_expired"))

    instance = main.Default()
    instance.env = make_env(FakeDatabase())
    return instance, done


class Event:
    """What the runtime hands a cron handler."""

    cron = "*/5 * * * *"
    scheduledTime = 1785292800000

    def waitUntil(self, _promise):
        return None


def test_the_runtime_calls_it_with_the_event_the_environment_and_the_context(worker):
    """Four positional arguments, which is what `introspection.py` does. Two is
    what this used to accept, and the difference was a job that never ran."""

    instance, done = worker

    asyncio.run(instance.scheduled(Event(), instance.env, Event()))

    assert done == ["expire_unpaid", "send_pending", "purge_expired"]


def test_it_still_works_when_only_the_event_is_passed(worker):
    """The older calling convention. Accepting both is what stops the next
    change of shape being another silent day."""

    instance, done = worker

    asyncio.run(instance.scheduled(Event()))

    assert done == ["expire_unpaid", "send_pending", "purge_expired"]
