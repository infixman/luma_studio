"""SigV4 presigning, checked against a real AWS implementation.

The signature either matches byte for byte or the URL is refused by R2, and a
hand-rolled signer that is *nearly* right fails in a way that says nothing
useful — 403 with no hint about which of a dozen canonicalisation rules was
broken. So the important test here is not a property, it is parity: botocore
signs the same request, and the two signatures have to be identical.

botocore is a test-only oracle. It does not exist in the Workers runtime and
must never be imported by anything under `src/`.
"""

import sys, pathlib
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))

from shared import sigv4


ACCOUNT = "0123456789abcdef0123456789abcdef"
ENDPOINT = f"https://{ACCOUNT}.r2.cloudflarestorage.com"
ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"


def botocore_signature(method: str, url: str, *, expires: int) -> tuple[str, str]:
    """Sign with botocore and return (its X-Amz-Date, its signature)."""

    from botocore.auth import S3SigV4QueryAuth
    from botocore.awsrequest import AWSRequest
    from botocore.credentials import Credentials

    request = AWSRequest(method=method, url=url)
    auth = S3SigV4QueryAuth(
        Credentials(ACCESS_KEY_ID, SECRET), "s3", sigv4.REGION, expires=expires
    )
    auth.add_auth(request)
    query = parse_qs(urlparse(request.url).query)
    return query["X-Amz-Date"][0], query["X-Amz-Signature"][0]


def instant_of(amz_date: str) -> int:
    from datetime import datetime, timezone

    return int(datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp())


def signature_of(url: str) -> str:
    return parse_qs(urlparse(url).query)["X-Amz-Signature"][0]


def ours(method: str, bucket: str, key: str, *, now: int, expires: int = 900) -> str:
    return sigv4.presigned_url(
        method=method,
        endpoint=ENDPOINT,
        bucket=bucket,
        key=key,
        access_key_id=ACCESS_KEY_ID,
        secret_access_key=SECRET,
        now=now,
        expires=expires,
    )


class TestParityWithBotocore:
    """Same inputs, same signature. Anything else is a 403 from R2."""

    @pytest.mark.parametrize(
        "method,bucket,key",
        [
            ("PUT", "luma-course-video", "videos/abc123/1/master.m3u8"),
            ("PUT", "luma-course-video", "videos/abc123/1/1080p/segment-000001.m4s"),
            ("PUT", "luma-course-video", "videos/abc123/12/poster.webp"),
            ("GET", "luma-course-source", "sources/abc123/1/source.mp4"),
            ("HEAD", "luma-course-video", "videos/a-b_c/3/480p/init.mp4"),
        ],
    )
    def test_the_signature_matches(self, method, bucket, key):
        url = f"{ENDPOINT}/{bucket}/{key}"
        amz_date, expected = botocore_signature(method, url, expires=900)

        assert signature_of(ours(method, bucket, key, now=instant_of(amz_date))) == expected

    def test_a_key_that_needs_encoding_is_encoded_the_same_way(self):
        """Nothing we generate looks like this. It is here because percent
        encoding is the rule most easily got wrong, and getting it wrong shows
        up only as a 403.

        botocore is handed the *encoded* path on purpose: for S3 it signs a URL
        exactly as given rather than encoding it, so passing the raw key would
        compare an encoded canonical path against an unencoded one and say
        nothing about whether our encoding is right. `~` stays literal and `+`
        becomes `%2B` in both, which is the AWS rule.
        """

        key = "sources/abc123/1/a b+c~d.mp4"
        encoded = "sources/abc123/1/a%20b%2Bc~d.mp4"
        amz_date, expected = botocore_signature("PUT", f"{ENDPOINT}/luma-course-source/{encoded}", expires=900)

        assert signature_of(ours("PUT", "luma-course-source", key, now=instant_of(amz_date))) == expected

    def test_a_longer_expiry_changes_the_signature_the_same_way(self):
        """`X-Amz-Expires` is signed, so a mismatch here fails only in the wild."""

        url = f"{ENDPOINT}/luma-course-video/videos/abc123/1/master.m3u8"
        amz_date, expected = botocore_signature("PUT", url, expires=7200)

        signed = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8",
                      now=instant_of(amz_date), expires=7200)

        assert signature_of(signed) == expected


SOURCE_KEY = "sources/abc123/1/source.mp4"
UPLOAD_ID = "ABPnzm4-tEXAMPLE_uploadId.with~chars+and/slash=="
# Written out rather than produced by `sigv4._encode`: handing the oracle the
# implementation's own encoding would compare the code with itself, which is the
# one thing this file exists not to do. `~` stays literal, everything else that
# is not unreserved is percent-encoded with upper-case hex — the AWS rule.
UPLOAD_ID_ENCODED = "ABPnzm4-tEXAMPLE_uploadId.with~chars%2Band%2Fslash%3D%3D"


def multipart(operation: str, *, key: str = SOURCE_KEY, now: int = 1785292800, **extra) -> str:
    return sigv4.presigned_multipart_url(
        operation=operation,
        endpoint=ENDPOINT,
        bucket="luma-course-source",
        key=key,
        access_key_id=ACCESS_KEY_ID,
        secret_access_key=SECRET,
        now=now,
        expires=900,
        **extra,
    )


class TestMultipartParityWithBotocore:
    """A source file is gigabytes, so it goes up in parts.

    The canonical request for these is not the one the single-PUT path produces:
    the operation lives in the query string (`?uploads`, `?uploadId=…&partNumber=…`),
    and the query string is signed. So each of the four gets its own parity check
    against botocore rather than an assumption that "it is the same code".
    """

    def _expected(self, method: str, query: str, *, key: str = SOURCE_KEY) -> tuple[str, str]:
        # botocore is handed the query exactly as it must be sent; for S3 it signs
        # the URL as given rather than rebuilding it.
        return botocore_signature(method, f"{ENDPOINT}/luma-course-source/{key}?{query}", expires=900)

    def test_starting_an_upload_matches(self):
        amz_date, expected = self._expected("POST", "uploads=")

        assert signature_of(multipart("create", now=instant_of(amz_date))) == expected

    def test_a_part_matches(self):
        amz_date, expected = self._expected("PUT", f"partNumber=3&uploadId={UPLOAD_ID_ENCODED}")

        signed = multipart("part", now=instant_of(amz_date), upload_id=UPLOAD_ID, part_number=3)

        assert signature_of(signed) == expected

    def test_finishing_an_upload_matches(self):
        amz_date, expected = self._expected("POST", f"uploadId={UPLOAD_ID_ENCODED}")

        signed = multipart("complete", now=instant_of(amz_date), upload_id=UPLOAD_ID)

        assert signature_of(signed) == expected

    def test_abandoning_an_upload_matches(self):
        amz_date, expected = self._expected("DELETE", f"uploadId={UPLOAD_ID_ENCODED}")

        signed = multipart("abort", now=instant_of(amz_date), upload_id=UPLOAD_ID)

        assert signature_of(signed) == expected


class TestWhatTheMultipartUrlCarries:
    def test_the_part_url_names_the_part_and_the_upload(self):
        query = parse_qs(urlparse(multipart("part", upload_id=UPLOAD_ID, part_number=7)).query)

        assert query["partNumber"] == ["7"]
        assert query["uploadId"] == [UPLOAD_ID]

    def test_starting_an_upload_asks_for_one(self):
        assert "uploads=" in urlparse(multipart("create")).query

    def test_the_upload_id_is_encoded_in_the_url_not_pasted_in(self):
        """It is an opaque string from R2 and it does contain `+`, `/` and `=`.
        Pasted raw, `+` reads as a space at the far end and the signature covers
        a different value than the one sent."""

        raw_query = urlparse(multipart("part", upload_id=UPLOAD_ID, part_number=1)).query

        assert f"uploadId={UPLOAD_ID_ENCODED}" in raw_query


class TestMultipartRefusals:
    """The reason this is a separate entrance from `presigned_url`.

    `presigned_url` signs GET/HEAD/PUT for one object. Multipart needs POST and
    DELETE, and a bare presigned DELETE for an object key is object deletion —
    which belongs in the back office, behind the reference checks. Here DELETE is
    only ever signed together with an `uploadId`, and the signature covers the
    query, so the URL cannot be turned into "delete this video".
    """

    def test_an_unknown_operation_is_refused(self):
        with pytest.raises(ValueError):
            multipart("delete-everything")

    @pytest.mark.parametrize("operation", ["part", "complete", "abort"])
    def test_an_operation_that_needs_an_upload_id_refuses_without_one(self, operation):
        with pytest.raises(ValueError):
            multipart(operation, part_number=1)

    def test_starting_an_upload_refuses_an_upload_id(self):
        """It is the call that produces one. Being handed one means the caller has
        confused two states, and signing it anyway would produce a URL that does
        something else."""

        with pytest.raises(ValueError):
            multipart("create", upload_id=UPLOAD_ID)

    def test_a_part_needs_a_part_number(self):
        with pytest.raises(ValueError):
            multipart("part", upload_id=UPLOAD_ID)

    @pytest.mark.parametrize("part_number", [0, -1, 10_001, True, "3", 3.0])
    def test_an_impossible_part_number_is_refused(self, part_number):
        with pytest.raises(ValueError):
            multipart("part", upload_id=UPLOAD_ID, part_number=part_number)

    def test_only_a_part_may_carry_a_part_number(self):
        with pytest.raises(ValueError):
            multipart("complete", upload_id=UPLOAD_ID, part_number=1)

    def test_a_traversing_key_is_still_refused(self):
        with pytest.raises(ValueError):
            multipart("create", key="sources/abc123/1/../../videos/other/1/master.m3u8")

    def test_an_empty_upload_id_is_refused(self):
        with pytest.raises(ValueError):
            multipart("abort", upload_id="")


class TestTheUrlItself:
    def test_it_carries_everything_r2_needs_to_verify_it(self):
        url = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)
        query = parse_qs(urlparse(url).query)

        assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
        assert query["X-Amz-Credential"] == [f"{ACCESS_KEY_ID}/20260729/{sigv4.REGION}/s3/aws4_request"]
        assert query["X-Amz-Date"] == ["20260729T024000Z"]
        assert query["X-Amz-Expires"] == ["900"]
        assert query["X-Amz-SignedHeaders"] == ["host"]
        assert len(query["X-Amz-Signature"][0]) == 64

    def test_the_path_is_the_bucket_then_the_key(self):
        url = ours("PUT", "luma-course-video", "videos/abc123/1/1080p/init.mp4", now=1785292800)

        assert urlparse(url).path == "/luma-course-video/videos/abc123/1/1080p/init.mp4"

    def test_the_host_is_the_account_endpoint(self):
        url = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)

        assert urlparse(url).netloc == f"{ACCOUNT}.r2.cloudflarestorage.com"


class TestWhatIsSigned:
    """Each of these is a thing an attacker would change on a granted URL."""

    def test_changing_the_key_invalidates_it(self):
        one = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)
        other = ours("PUT", "luma-course-video", "videos/abc123/2/master.m3u8", now=1785292800)

        assert signature_of(one) != signature_of(other)

    def test_changing_the_bucket_invalidates_it(self):
        one = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)
        other = ours("PUT", "luma-course-source", "videos/abc123/1/master.m3u8", now=1785292800)

        assert signature_of(one) != signature_of(other)

    def test_changing_the_method_invalidates_it(self):
        """A PUT URL must not also be a GET URL: writing and reading are not the
        same grant."""

        one = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)
        other = ours("GET", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)

        assert signature_of(one) != signature_of(other)

    def test_a_later_instant_invalidates_it(self):
        one = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)
        other = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292801)

        assert signature_of(one) != signature_of(other)


class TestRefusals:
    def test_an_unknown_method_is_refused(self):
        """The method is part of the grant, so the list of them is ours to keep
        short rather than something to pass through."""

        with pytest.raises(ValueError):
            ours("DELETE", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)

    def test_an_empty_key_is_refused(self):
        with pytest.raises(ValueError):
            ours("PUT", "luma-course-video", "", now=1785292800)

    def test_an_absolute_key_is_refused(self):
        """A leading slash makes the canonical path ambiguous, and the signature
        would then cover a path R2 reads differently."""

        with pytest.raises(ValueError):
            ours("PUT", "luma-course-video", "/videos/abc123/1/master.m3u8", now=1785292800)

    def test_a_traversing_key_is_refused(self):
        with pytest.raises(ValueError):
            ours("PUT", "luma-course-video", "videos/abc123/1/../../other/x", now=1785292800)

    def test_an_empty_segment_is_refused(self):
        with pytest.raises(ValueError):
            ours("PUT", "luma-course-video", "videos//1/master.m3u8", now=1785292800)

    def test_a_traversing_bucket_is_refused(self):
        """Configuration, not input — but `.` and `..` survive percent encoding,
        so a typo in a binding would put a traversal in a signed path."""

        with pytest.raises(ValueError):
            ours("PUT", "..", "videos/abc123/1/master.m3u8", now=1785292800)

    def test_an_endpoint_with_a_path_is_refused(self):
        """It would be signed into the Host header, which R2 reads as a
        different host — a 403 with nothing in it to explain itself."""

        with pytest.raises(ValueError):
            sigv4.presigned_url(
                method="PUT",
                endpoint=f"{ENDPOINT}/luma-course-video",
                bucket="luma-course-video",
                key="videos/abc123/1/master.m3u8",
                access_key_id=ACCESS_KEY_ID,
                secret_access_key=SECRET,
                now=1785292800,
                expires=900,
            )

    @pytest.mark.parametrize("expires", [0, -1, sigv4.MAX_EXPIRES + 1])
    def test_an_impossible_expiry_is_refused(self, expires):
        with pytest.raises(ValueError):
            ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800, expires=expires)

    def test_a_missing_credential_is_refused(self):
        """An unsigned URL that looks signed is worse than an error: it reaches
        R2, fails there, and the log says nothing about why."""

        with pytest.raises(ValueError):
            sigv4.presigned_url(
                method="PUT",
                endpoint=ENDPOINT,
                bucket="luma-course-video",
                key="videos/abc123/1/master.m3u8",
                access_key_id="",
                secret_access_key=SECRET,
                now=1785292800,
                expires=900,
            )


class TestSecretsStayOut:
    def test_the_url_never_contains_the_secret(self):
        url = ours("PUT", "luma-course-video", "videos/abc123/1/master.m3u8", now=1785292800)

        assert SECRET not in url
