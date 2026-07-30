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
