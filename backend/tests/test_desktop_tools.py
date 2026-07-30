"""Serving the pinned FFmpeg the desktop tool downloads.

The tool refuses to run any FFmpeg but the one named in `ffmpegRelease.ts`, and
it fetches that one from here. So this endpoint hands out a file by name, which
is the shape of every path-traversal bug ever written — hence a name allowlist
rather than a sanitiser, and a test for each way somebody would try to leave the
prefix.

The bytes are not secret: it is a published GPL build. The reason it is behind
the desktop token anyway is bandwidth — an open endpoint serving twenty megabytes
per request is somebody else's free CDN.
"""

import pytest

from domain import desktop_auth, desktop_tools


class TestMirrorKey:
    def test_a_pinned_archive_resolves_under_the_prefix(self):
        assert desktop_tools.mirror_key("ffmpeg-8.1.2-min.zip") == "ffmpeg/ffmpeg-8.1.2-min.zip"

    def test_the_source_archives_resolve_too(self):
        # The other half of the GPL obligation lives in the same prefix, so the
        # licence window's "open the source folder" has something to open.
        for name in ("ffmpeg-38b88335f9-source.zip", "x264-snapshot.tar.bz2"):
            assert desktop_tools.mirror_key(name) is not None

    @pytest.mark.parametrize(
        "name",
        [
            "../wrangler.admin.toml",
            "..%2Fsecrets",
            "a/../../etc/passwd",
            "sub/dir/archive.zip",
            "back\\slash.zip",
            ".hidden.zip",
            "",
            "   ",
            "archive.zip ",
            "a" * 200 + ".zip",
        ],
    )
    def test_anything_that_is_not_a_plain_file_name_is_refused(self, name):
        assert desktop_tools.mirror_key(name) is None

    @pytest.mark.parametrize("name", ["ffmpeg.exe", "notes.txt", "archive.sh", "payload.dll"])
    def test_and_only_archive_suffixes_are_served(self, name):
        # Not because an .exe is unsafe to hold in a bucket, but because this
        # route exists to hand over an archive the tool then verifies by digest.
        # Anything else reaching it means the mirror holds something nobody
        # planned for.
        assert desktop_tools.mirror_key(name) is None

    def test_a_name_differing_only_in_case_is_still_just_a_name(self):
        # R2 keys are case-sensitive, so this must not be lowercased on the way
        # through — the digest check would fail on a file that is really there.
        assert desktop_tools.mirror_key("FFmpeg-Min.ZIP") == "ffmpeg/FFmpeg-Min.ZIP"


class TestScope:
    def test_a_video_token_may_fetch_the_mirror(self):
        # It is the same tool, in the middle of the same job: it has an MP4 to
        # transcode and no FFmpeg to do it with.
        assert desktop_auth.scope_allows(
            desktop_auth.SCOPE_VIDEO, "GET", "/tools/ffmpeg/ffmpeg-8.1.2-min.zip"
        )

    @pytest.mark.parametrize(
        "method,path",
        [
            ("POST", "/tools/ffmpeg/ffmpeg-8.1.2-min.zip"),
            ("DELETE", "/tools/ffmpeg/ffmpeg-8.1.2-min.zip"),
            ("GET", "/tools/ffmpeg/"),
            ("GET", "/tools/ffmpeg/../../api/orders"),
            ("GET", "/tools/"),
            ("GET", "/api/orders"),
        ],
    )
    def test_and_nothing_else(self, method, path):
        assert not desktop_auth.scope_allows(desktop_auth.SCOPE_VIDEO, method, path)


class TestMirrorRoute:
    """The route, against the real worker.

    The scope check and the name check are unit-tested above; this is here because
    what joins them is one `if` in `admin_main`, and the interesting answers are
    the ones that are *not* the file: no token, a name that leaves the prefix, and
    a deployment with no mirror bound.
    """

    ARCHIVE = "ffmpeg-8.1.2-min.zip"
    BYTES = b"PK not really a zip, but the route does not care"

    R2 = {
        "R2_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com",
        "R2_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
        "R2_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "COURSE_SOURCE_BUCKET": "luma-course-source",
        "COURSE_VIDEO_BUCKET": "luma-course-video",
        "VIDEO_UPLOAD_ENABLED": "1",
    }

    @pytest.fixture
    def worker(self):
        import asyncio

        from conftest import ADMIN_ORIGIN, FakeBucket, FakeDatabase, FakeObject, make_env
        from test_desktop import PAIRING_SECRET, TOKEN_SECRET

        import admin_main
        from shared import migrations

        def run(request, *, mirror=True):
            migrations._applied_names = None
            instance = admin_main.Default()
            extra = dict(
                self.R2,
                DESKTOP_PAIRING_SECRET=PAIRING_SECRET,
                DESKTOP_TOKEN_SECRET=TOKEN_SECRET,
            )
            if mirror:
                extra["DESKTOP_TOOLS"] = FakeBucket(
                    {f"ffmpeg/{self.ARCHIVE}": FakeObject(self.BYTES)}
                )
            instance.env = make_env(
                FakeDatabase({}), origins=ADMIN_ORIGIN, frontend=ADMIN_ORIGIN, **extra
            )
            return asyncio.run(instance.fetch(request))

        return run

    def _token(self, worker) -> str:
        from conftest import ADMIN_ORIGIN
        from test_desktop import OWNER, JsonRequest, paired_env

        from domain import desktop_auth
        from shared.common import utc_timestamp

        code = desktop_auth.pairing_code(paired_env(), OWNER, now=utc_timestamp())["code"]
        response = worker(
            JsonRequest("/api/desktop/tokens", "POST", {"email": OWNER, "code": code})
        )
        assert response.status == 200, response.body
        return response.json()["token"]

    def _get(self, name: str, token: str | None):
        from conftest import ADMIN_ORIGIN
        from test_desktop import JsonRequest

        headers = {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return JsonRequest(f"/tools/ffmpeg/{name}", "GET", {}, headers)

    def test_a_paired_tool_gets_the_archive(self, worker):
        token = self._token(worker)

        response = worker(self._get(self.ARCHIVE, token))

        assert response.status == 200
        assert response.body == self.BYTES

    def test_it_may_be_cached_for_ever(self, worker):
        # The name carries the version and the tool checks a digest, so a stale
        # copy cannot be a wrong copy.
        token = self._token(worker)

        response = worker(self._get(self.ARCHIVE, token))

        assert "immutable" in response.headers.get("cache-control", "")

    def test_without_a_token_it_is_not_served(self, worker):
        response = worker(self._get(self.ARCHIVE, None))

        assert response.status == 401

    def test_a_name_that_leaves_the_prefix_is_not_found(self, worker):
        token = self._token(worker)

        response = worker(self._get("../../wrangler.admin.toml", token))

        assert response.status in (403, 404)

    def test_a_missing_object_is_not_found(self, worker):
        token = self._token(worker)

        response = worker(self._get("ffmpeg-9.9.9-min.zip", token))

        assert response.status == 404

    def test_an_unconfigured_mirror_says_so_rather_than_404(self, worker):
        # A deployment with no bucket bound and a mirror with nothing in it look
        # the same from the tool, and only one of them is fixed by uploading.
        token = self._token(worker)

        response = worker(self._get(self.ARCHIVE, token), mirror=False)

        assert response.status == 503
        assert "DESKTOP_TOOLS" in response.body
