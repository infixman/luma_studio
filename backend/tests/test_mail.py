"""Order notifications: what gets written, what gets sent, and what does not."""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def mail():
    import mail as module

    return module


def order(order_id="LS20260728abcdefg", store=None):
    return {
        "id": order_id,
        "status": "pending",
        "subtotal": 600,
        "shippingFee": 60,
        "total": 660,
        "shippingMethod": "711",
        "recipientName": "王小明",
        "recipientPhone": "0912345678",
        "recipientEmail": "wang@example.com",
        "shippingAddress": "台北市中山區",
        "storeName": store,
        "storeAddr": None,
        "reservedUntil": None,
        "paidAt": None,
        "createdAt": 1700000000,
    }


ITEMS = [{"productTitle": "材料包", "variantTitle": "標準", "unitPrice": 300, "quantity": 2, "subtotal": 600}]


def configured_env(database=None, **extra):
    return make_env(
        database or FakeDatabase(),
        MAIL_FROM="shop@luma-studio.tw",
        RESEND_API_KEY="re_test",
        **extra,
    )


class TestWhetherMailIsOn:
    def test_both_settings_are_needed(self, mail):
        """A key with no address cannot produce a message; an address with no
        key cannot deliver one."""

        assert mail.configured(make_env(MAIL_FROM="a@b.c")) is False
        assert mail.configured(make_env(RESEND_API_KEY="re_x")) is False
        assert mail.configured(configured_env()) is True

    def test_nothing_is_queued_while_it_is_off(self, mail):
        """Otherwise a month of rows all go out the moment a key is added, and
        someone hears in June that their April order shipped."""

        database = FakeDatabase()
        queued = asyncio.run(
            mail.queue(make_env(database), kind="created", recipient="a@b.c", subject="x", body="y")
        )
        assert queued is False
        assert database.writes == []

    def test_draining_while_it_is_off_reads_nothing(self, mail):
        database = FakeDatabase()
        assert asyncio.run(mail.send_pending(make_env(database)))["skipped"] is True
        assert database.statements == []


class TestWhatCustomersHear:
    @pytest.mark.parametrize("kind", ["created", "paid", "shipped", "cancelled", "expired"])
    def test_every_change_worth_hearing_about_has_a_message(self, mail, kind):
        composed = mail.compose(kind, order(), ITEMS)
        assert composed is not None
        subject, body = composed
        assert "LS20260728abcdefg" in subject
        assert body.startswith("王小明 您好，")

    def test_completing_an_order_sends_nothing(self, mail):
        """"Your order is complete" arrives after the parcel did, and says less
        than the parcel."""

        assert mail.compose("completed", order(), ITEMS) is None

    def test_an_unknown_kind_sends_nothing_rather_than_something_empty(self, mail):
        assert mail.compose("refunded", order(), ITEMS) is None

    def test_the_confirmation_shows_what_was_bought_and_the_total(self, mail):
        _, body = mail.compose("created", order(), ITEMS)
        assert "材料包" in body and "NT$600" in body and "NT$660" in body

    def test_a_store_pickup_names_the_store_rather_than_an_address(self, mail):
        _, body = mail.compose("created", order(store="門市"), ITEMS)
        assert "取貨門市：門市" in body
        assert "台北市中山區" not in body

    def test_a_cancellation_carries_the_reason_when_there_is_one(self, mail):
        _, with_reason = mail.compose("cancelled", order(), ITEMS, detail="缺貨")
        _, without = mail.compose("cancelled", order(), ITEMS)
        assert "缺貨" in with_reason
        assert "原因" not in without

    def test_the_shipping_notice_carries_the_tracking_note(self, mail):
        _, body = mail.compose("shipped", order(), ITEMS, detail="7-11 交寄 A123")
        assert "A123" in body


class TestTheOwnerAlert:
    def test_it_carries_the_contact_details_and_a_link(self, mail):
        subject, body = mail.owner_alert(order(), ITEMS)
        assert "NT$660" in subject
        assert "0912345678" in body and "wang@example.com" in body
        assert "admin.luma-studio.tw/orders?q=LS20260728abcdefg" in body

    def test_no_owner_address_means_no_alert(self, mail):
        database = FakeDatabase()
        asyncio.run(mail.queue_owner_alert(configured_env(database), order(), ITEMS))
        assert database.writes == []


class TestQueueing:
    def test_a_queued_message_starts_pending(self, mail):
        database = FakeDatabase()
        asyncio.run(mail.queue_order_event(configured_env(database), "paid", order(), ITEMS))
        written = [write for write in database.writes if "INSERT INTO email_outbox" in write[0]]
        assert len(written) == 1
        assert written[0][1][3] == "wang@example.com"

    def test_an_order_with_no_email_queues_nothing(self, mail):
        database = FakeDatabase()
        nameless = {**order(), "recipientEmail": ""}
        asyncio.run(mail.queue_order_event(configured_env(database), "paid", nameless, ITEMS))
        assert database.writes == []


class FakeResponse:
    def __init__(self, ok=True, status=200, text=""):
        self.ok = ok
        self.status = status
        self._text = text

    async def text(self):
        return self._text


def outbox_row(row_id="msg1", attempts=0):
    return {
        "id": row_id,
        "order_id": "LS20260728abcdefg",
        "kind": "paid",
        "recipient": "wang@example.com",
        "subject": "s",
        "body": "b",
        "status": "pending",
        "attempts": attempts,
        "last_error": "",
        "created_at": 1700000000,
        "sent_at": None,
    }


def drain(mail, database, monkeypatch, result):
    """Run the drain with the provider replaced."""

    calls = []

    async def fake_post(env, message):
        calls.append(message["id"])
        return result

    monkeypatch.setattr(mail, "_post", fake_post)
    outcome = asyncio.run(mail.send_pending(configured_env(database)))
    return outcome, calls


class TestSending:
    def test_a_sent_message_is_marked_and_stamped(self, mail, monkeypatch):
        database = FakeDatabase({"FROM email_outbox": [outbox_row()]})
        outcome, calls = drain(mail, database, monkeypatch, (True, ""))
        assert outcome["sent"] == 1 and calls == ["msg1"]
        written = [write for write in database.writes if "UPDATE email_outbox" in write[0]][0]
        assert "status = 'sent'" in written[0]

    def test_a_failure_leaves_it_pending_for_the_next_run(self, mail, monkeypatch):
        """A provider outage is temporary. The row waits."""

        database = FakeDatabase({"FROM email_outbox": [outbox_row()]})
        outcome, _ = drain(mail, database, monkeypatch, (False, "503 busy"))
        assert outcome["failed"] == 1
        written = [write for write in database.writes if "UPDATE email_outbox" in write[0]][0]
        assert written[1][1] == "pending"
        assert written[1][3] == "503 busy"

    def test_it_gives_up_after_enough_tries(self, mail, monkeypatch):
        """A mailbox that does not exist will not start existing."""

        database = FakeDatabase({"FROM email_outbox": [outbox_row(attempts=mail.MAX_ATTEMPTS - 1)]})
        drain(mail, database, monkeypatch, (False, "422 invalid"))
        written = [write for write in database.writes if "UPDATE email_outbox" in write[0]][0]
        assert written[1][1] == "failed"

    def test_each_message_is_settled_on_its_own(self, mail, monkeypatch):
        """One bad address must not hold up everything queued behind it."""

        database = FakeDatabase({"FROM email_outbox": [outbox_row("a"), outbox_row("b")]})
        outcome, calls = drain(mail, database, monkeypatch, (True, ""))
        assert calls == ["a", "b"] and outcome["sent"] == 2

    def test_only_pending_rows_are_read(self, mail, monkeypatch):
        database = FakeDatabase({"FROM email_outbox": [outbox_row()]})
        drain(mail, database, monkeypatch, (True, ""))
        assert "status = 'pending'" in database.statements[0]


class TestOrdersQueueTheirOwnNotices:
    def test_marking_paid_queues_the_receipt(self, monkeypatch):
        import orders

        database = FakeDatabase({"FROM orders": [_order_record()]}, {"UPDATE orders": 1})
        asyncio.run(orders.mark_paid(configured_env(database), "LS20260728abcdefg", "owner@example.com"))
        assert any("INSERT INTO email_outbox" in write[0] for write in database.writes)

    def test_a_queue_that_will_not_write_does_not_undo_the_move(self, monkeypatch):
        """The order moved. A mail row is not worth reversing that."""

        import mail as mail_module
        import orders

        async def explode(*_args, **_kwargs):
            raise RuntimeError("outbox is on fire")

        monkeypatch.setattr(mail_module, "queue_order_event", explode)
        database = FakeDatabase({"FROM orders": [_order_record()]}, {"UPDATE orders": 1})
        assert asyncio.run(orders.mark_paid(configured_env(database), "LS20260728abcdefg", "me")) is True


def _order_record():
    return {
        "id": "LS20260728abcdefg",
        "customer_id": "cust1",
        "status": "pending",
        "subtotal": 600,
        "shipping_fee": 60,
        "total": 660,
        "shipping_method": "711",
        "recipient_name": "王小明",
        "recipient_phone": "0912345678",
        "recipient_email": "wang@example.com",
        "shipping_address": "台北市",
        "store_name": None,
        "store_addr": None,
        "reserved_until": None,
        "paid_at": None,
        "admin_note": "",
        "created_at": 1700000000,
    }
