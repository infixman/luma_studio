"""Talking to R2's S3 API from inside the Worker.

The desktop tool uploads the parts; the Worker starts, finishes and cancels the
upload, because those are the steps a session row has to know about. That means
three signed requests the Worker sends itself, and this file is about the ways
they go wrong quietly:

`CompleteMultipartUpload` answers **200 with an error inside the body**. It is
the oldest trap in the S3 API — the connection has to stay open while the parts
are assembled, so the status line is written before the outcome is known. Code
that checks `response.ok` and moves on records a finished upload that does not
exist.

An abort of an upload that is already gone is a success, not a failure. Retrying
one is the ordinary path, and a 404 there means the desired state was reached.
"""

import asyncio

import pytest


ENDPOINT = "https://0123456789abcdef.r2.cloudflarestorage.com"
CREDENTIALS = {
    "endpoint": ENDPOINT,
    "access_key_id": "AKIAIOSFODNN7EXAMPLE",
    "secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
}
KEY = "sources/abc123/1/source.mp4"
UPLOAD_ID = "ABPnzm4-tEXAMPLE+uploadId"
ETAG_ONE = '"9b2cf535f27731c974343645a3985328"'
ETAG_TWO = '"c2f6a8bb0ef1a7a2a3d8f4b5c6d7e8f9"'

STARTED = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    "<Bucket>luma-course-source</Bucket><Key>sources/abc123/1/source.mp4</Key>"
    f"<UploadId>{UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>"
)

COMPLETED = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    "<Location>https://example/x</Location><Bucket>luma-course-source</Bucket>"
    "<Key>sources/abc123/1/source.mp4</Key><ETag>&quot;deadbeef-2&quot;</ETag>"
    "</CompleteMultipartUploadResult>"
)

# The trap: HTTP 200, and the upload did not happen.
COMPLETE_FAILED = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    "<Error><Code>InvalidPart</Code><Message>One or more of the specified parts"
    " could not be found</Message></Error>"
)


@pytest.fixture
def r2_s3():
    from shared import r2_s3 as module

    return module


class Sent:
    """Records what the Worker asked R2 to do, and answers with a script."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    async def __call__(self, url: str, *, method: str, body=None, content_type=None):
        self.calls.append({"url": url, "method": method, "body": body, "content_type": content_type})
        status, text = self.replies.pop(0) if self.replies else (200, "")
        return status, text


def sending(r2_s3, monkeypatch, *replies) -> Sent:
    sent = Sent(replies)
    monkeypatch.setattr(r2_s3, "_send", sent)
    return sent


class TestTheRequestItself:
    """The one place `fetch` is called, and the only part these tests can reach
    without a Workers runtime. Everything else here monkeypatches `_send`, which
    is exactly why what happens *inside* it needs its own tests: the first
    version of this module let a dropped connection propagate as whatever the
    runtime raises, and a caller catching `R2Error` would not have caught it."""

    def _fetching(self, r2_s3, monkeypatch, reply):
        calls: list[tuple] = []

        async def fake_fetch(url, options):
            calls.append((url, options))
            if isinstance(reply, Exception):
                raise reply
            return reply

        monkeypatch.setattr(r2_s3, "js_fetch", fake_fetch)
        return calls

    class Reply:
        def __init__(self, status=200, text="", explode=False):
            self.status = status
            self._text = text
            self._explode = explode

        async def text(self):
            if self._explode:
                raise RuntimeError("connection reset while reading")
            return self._text

    def test_a_body_is_sent_as_xml(self, r2_s3, monkeypatch):
        calls = self._fetching(r2_s3, monkeypatch, self.Reply(200, COMPLETED))

        asyncio.run(r2_s3._send("https://example/x", method="POST", body="<x/>"))

        _, options = calls[0]
        assert options["method"] == "POST"
        assert options["body"] == "<x/>"
        assert options["headers"]["content-type"] == "application/xml"

    def test_a_request_with_no_body_sends_no_headers(self, r2_s3, monkeypatch):
        """A DELETE with a content-type is a request describing a body it does
        not have."""

        calls = self._fetching(r2_s3, monkeypatch, self.Reply(204, ""))

        asyncio.run(r2_s3._send("https://example/x", method="DELETE"))

        assert "headers" not in calls[0][1]

    def test_a_dropped_connection_is_an_r2_error(self, r2_s3, monkeypatch):
        """Not whatever the runtime raises. A caller distinguishing "R2 said no"
        from "the network broke" has to be able to catch one type."""

        self._fetching(r2_s3, monkeypatch, RuntimeError("network is unreachable"))

        with pytest.raises(r2_s3.R2Error):
            asyncio.run(r2_s3._send("https://example/x", method="POST"))

    def test_a_body_that_will_not_read_is_an_r2_error(self, r2_s3, monkeypatch):
        self._fetching(r2_s3, monkeypatch, self.Reply(200, "", explode=True))

        with pytest.raises(r2_s3.R2Error):
            asyncio.run(r2_s3._send("https://example/x", method="POST"))

    def test_the_failure_does_not_repeat_the_signed_url(self, r2_s3, monkeypatch):
        self._fetching(r2_s3, monkeypatch, RuntimeError("network is unreachable"))

        with pytest.raises(r2_s3.R2Error) as raised:
            asyncio.run(r2_s3._send("https://example/x?X-Amz-Signature=abc", method="POST"))

        assert "X-Amz-Signature" not in str(raised.value)


class TestStartingAnUpload:
    def test_it_returns_the_upload_id_r2_issued(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (200, STARTED))

        upload_id = asyncio.run(
            r2_s3.start_multipart(credentials=CREDENTIALS, bucket="luma-course-source", key=KEY, now=1785292800)
        )

        assert upload_id == UPLOAD_ID

    def test_it_asks_r2_to_start_one(self, r2_s3, monkeypatch):
        sent = sending(r2_s3, monkeypatch, (200, STARTED))

        asyncio.run(
            r2_s3.start_multipart(credentials=CREDENTIALS, bucket="luma-course-source", key=KEY, now=1785292800)
        )

        assert sent.calls[0]["method"] == "POST"
        assert "uploads=" in sent.calls[0]["url"]
        assert f"/luma-course-source/{KEY}" in sent.calls[0]["url"]

    def test_an_answer_without_an_upload_id_is_a_failure(self, r2_s3, monkeypatch):
        """Returning an empty id would produce part URLs that sign nothing
        useful, and the upload would fail hundreds of parts later."""

        sending(r2_s3, monkeypatch, (200, "<InitiateMultipartUploadResult></InitiateMultipartUploadResult>"))

        with pytest.raises(r2_s3.R2Error):
            asyncio.run(
                r2_s3.start_multipart(credentials=CREDENTIALS, bucket="luma-course-source", key=KEY, now=1785292800)
            )

    def test_a_two_hundred_with_an_error_inside_it_names_the_code(self, r2_s3, monkeypatch):
        """It fails either way, because an error body has no upload id in it —
        but "R2 started an upload without saying which one" tells an operator
        nothing, and `AccessDenied` tells them everything."""

        sending(r2_s3, monkeypatch, (200, "<Error><Code>AccessDenied</Code></Error>"))

        with pytest.raises(r2_s3.R2Error) as raised:
            asyncio.run(
                r2_s3.start_multipart(credentials=CREDENTIALS, bucket="luma-course-source", key=KEY, now=1785292800)
            )

        assert "AccessDenied" in str(raised.value)

    def test_the_failure_carries_the_code_as_a_value(self, r2_s3, monkeypatch):
        """The route layer has to tell `NoSuchUpload` from the rest, and parsing
        it back out of a sentence is not a way to do that."""

        sending(r2_s3, monkeypatch, (403, "<Error><Code>SignatureDoesNotMatch</Code></Error>"))

        with pytest.raises(r2_s3.R2Error) as raised:
            asyncio.run(
                r2_s3.start_multipart(credentials=CREDENTIALS, bucket="luma-course-source", key=KEY, now=1785292800)
            )

        assert raised.value.code == "SignatureDoesNotMatch"
        assert raised.value.status == 403

    def test_credentials_missing_a_field_are_refused_as_ours_not_as_r2s(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (200, STARTED))

        with pytest.raises(r2_s3.R2Error):
            asyncio.run(
                r2_s3.start_multipart(
                    credentials={"endpoint": ENDPOINT}, bucket="luma-course-source", key=KEY, now=1785292800
                )
            )

    def test_a_refusal_is_reported_without_the_signed_url(self, r2_s3, monkeypatch):
        """The URL is a bearer credential with fifteen minutes left on it, and an
        error message is the one place nobody reads carefully."""

        sending(r2_s3, monkeypatch, (403, "<Error><Code>SignatureDoesNotMatch</Code></Error>"))

        with pytest.raises(r2_s3.R2Error) as raised:
            asyncio.run(
                r2_s3.start_multipart(credentials=CREDENTIALS, bucket="luma-course-source", key=KEY, now=1785292800)
            )

        assert "X-Amz-Signature" not in str(raised.value)
        assert CREDENTIALS["secret_access_key"] not in str(raised.value)


class TestFinishingAnUpload:
    def _complete(self, r2_s3, parts=((1, ETAG_ONE), (2, ETAG_TWO)), now=1785292800):
        return asyncio.run(
            r2_s3.complete_multipart(
                credentials=CREDENTIALS,
                bucket="luma-course-source",
                key=KEY,
                upload_id=UPLOAD_ID,
                parts=list(parts),
                now=now,
            )
        )

    def test_it_sends_the_parts_in_order(self, r2_s3, monkeypatch):
        sent = sending(r2_s3, monkeypatch, (200, COMPLETED))

        self._complete(r2_s3, parts=((2, ETAG_TWO), (1, ETAG_ONE)))

        body = sent.calls[0]["body"]
        assert body.index("<PartNumber>1</PartNumber>") < body.index("<PartNumber>2</PartNumber>")
        assert f"<ETag>{ETAG_ONE}</ETag>" in body

    def test_it_returns_the_finished_object_tag(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (200, COMPLETED))

        assert self._complete(r2_s3) == '"deadbeef-2"'

    def test_a_two_hundred_with_an_error_inside_it_is_a_failure(self, r2_s3, monkeypatch):
        """The connection stays open while R2 assembles the parts, so the status
        line is written before the outcome is known. Trusting it records a
        finished upload that does not exist."""

        sending(r2_s3, monkeypatch, (200, COMPLETE_FAILED))

        with pytest.raises(r2_s3.R2Error) as raised:
            self._complete(r2_s3)

        assert "InvalidPart" in str(raised.value)

    def test_finishing_with_no_parts_is_refused_before_it_is_sent(self, r2_s3, monkeypatch):
        """An empty part list completes to a zero-byte object, and the asset
        would then have a source file that is not the video."""

        sent = sending(r2_s3, monkeypatch, (200, COMPLETED))

        with pytest.raises(ValueError):
            self._complete(r2_s3, parts=())

        assert sent.calls == []

    def test_a_part_named_twice_is_refused(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (200, COMPLETED))

        with pytest.raises(ValueError):
            self._complete(r2_s3, parts=((1, ETAG_ONE), (1, ETAG_TWO)))

    @pytest.mark.parametrize("number", [0, -1, 10_001, "1", True])
    def test_an_impossible_part_number_is_refused(self, r2_s3, monkeypatch, number):
        sending(r2_s3, monkeypatch, (200, COMPLETED))

        with pytest.raises(ValueError):
            self._complete(r2_s3, parts=((number, ETAG_ONE),))

    def test_an_etag_that_would_break_the_xml_is_refused(self, r2_s3, monkeypatch):
        """The tag comes back through the desktop tool, so it is not ours. A
        `<` in it would let the caller write the rest of the document."""

        sending(r2_s3, monkeypatch, (200, COMPLETED))

        with pytest.raises(ValueError):
            self._complete(r2_s3, parts=((1, '"a</ETag><Part>"'),))

    def test_an_empty_etag_is_refused(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (200, COMPLETED))

        with pytest.raises(ValueError):
            self._complete(r2_s3, parts=((1, ""),))


class TestCancellingAnUpload:
    def _abort(self, r2_s3):
        return asyncio.run(
            r2_s3.abort_multipart(
                credentials=CREDENTIALS,
                bucket="luma-course-source",
                key=KEY,
                upload_id=UPLOAD_ID,
                now=1785292800,
            )
        )

    def test_it_deletes_the_pending_upload(self, r2_s3, monkeypatch):
        sent = sending(r2_s3, monkeypatch, (204, ""))

        self._abort(r2_s3)

        assert sent.calls[0]["method"] == "DELETE"
        assert "uploadId=" in sent.calls[0]["url"]

    def test_an_upload_that_is_already_gone_counts_as_cancelled(self, r2_s3, monkeypatch):
        """Retrying an abort is the ordinary path, and the second one finds
        nothing. That is the desired state, not a failure to report."""

        sending(r2_s3, monkeypatch, (404, "<Error><Code>NoSuchUpload</Code></Error>"))

        assert self._abort(r2_s3) is None

    def test_any_other_refusal_is_still_a_failure(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (403, "<Error><Code>AccessDenied</Code></Error>"))

        with pytest.raises(r2_s3.R2Error):
            self._abort(r2_s3)

    def test_a_missing_bucket_is_not_a_cancelled_upload(self, r2_s3, monkeypatch):
        """A 404 saying the bucket does not exist is a misconfiguration, and
        reporting it as "cancelled" hides it until somebody notices the storage
        bill. Only an upload that is gone counts as gone."""

        sending(r2_s3, monkeypatch, (404, "<Error><Code>NoSuchBucket</Code></Error>"))

        with pytest.raises(r2_s3.R2Error):
            self._abort(r2_s3)


class TestFinishingTwice:
    """`complete` cannot be made idempotent here, and pretending otherwise is
    worse than saying so.

    Once an upload completes, its id stops existing — so a second complete and a
    complete of an id that never existed answer with the same `NoSuchUpload`.
    From inside this module those are indistinguishable, and the case that
    matters is the one where R2 finished the object and the answer was lost.

    So the code hands the caller the code rather than a verdict: the route layer
    has a session row and can look at the object.
    """

    def test_the_ambiguous_answer_is_identifiable(self, r2_s3, monkeypatch):
        sending(r2_s3, monkeypatch, (404, "<Error><Code>NoSuchUpload</Code></Error>"))

        with pytest.raises(r2_s3.R2Error) as raised:
            asyncio.run(
                r2_s3.complete_multipart(
                    credentials=CREDENTIALS,
                    bucket="luma-course-source",
                    key=KEY,
                    upload_id=UPLOAD_ID,
                    parts=[(1, ETAG_ONE)],
                    now=1785292800,
                )
            )

        assert raised.value.code == "NoSuchUpload"
