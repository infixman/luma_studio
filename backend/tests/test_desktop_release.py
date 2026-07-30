"""Which versions of the tool are allowed to work.

The policy exists because of one trap: if 1.0.0 is installed and the update
mechanism turns out to be broken, there is no way to push a fix. So the server
gets to say "too old" and "stop entirely", and both have to be answerable before
the first release rather than after somebody needs them.

Comparing versions is the part that looks trivial and is not. `"1.10.0" <
"1.9.0"` is true as strings, which would tell every tool on the newest version
that it is out of date.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def release():
    from domain import desktop_release as module

    return module


def a_policy(**extra) -> dict:
    return {
        "latest": "1.2.0",
        "min_supported": "1.0.0",
        "force_update": 0,
        "blocked": 0,
        "notes": "",
        "updated_at": 0,
        **extra,
    }


class TestComparingVersions:
    def test_a_later_patch_is_later(self, release):
        assert release.compare("1.0.1", "1.0.0") > 0

    def test_ten_comes_after_nine(self, release):
        """As strings it does not, and the consequence is telling everybody on
        the newest build that they are out of date."""

        assert release.compare("1.10.0", "1.9.0") > 0

    def test_the_same_version_is_the_same(self, release):
        assert release.compare("1.2.3", "1.2.3") == 0

    def test_a_missing_part_reads_as_zero(self, release):
        """electron-builder writes `1.2` in some places and `1.2.0` in others."""

        assert release.compare("1.2", "1.2.0") == 0

    @pytest.mark.parametrize("value", ["", "next", "1.2.x", "v1.2.0", None])
    def test_something_that_is_not_a_version_is_refused(self, release, value):
        """Guessing what a caller meant is how a tool with a corrupted version
        string ends up treated as current."""

        with pytest.raises(ValueError):
            release.compare(value, "1.0.0")


class TestTheVerdict:
    def _verdict(self, release, version, **policy):
        return release.verdict(release.policy_row(a_policy(**policy)), version)

    def test_the_current_version_may_work(self, release):
        answer = self._verdict(release, "1.2.0")

        assert answer["allowed"] is True
        assert answer["updateAvailable"] is False

    def test_an_older_but_supported_version_works_and_is_told_about_the_new_one(self, release):
        answer = self._verdict(release, "1.1.0")

        assert answer["allowed"] is True
        assert answer["updateAvailable"] is True

    def test_below_the_minimum_stops(self, release):
        """The tool signs uploads and writes to a bucket. A version old enough
        to have a known bug in that path should not be doing it."""

        answer = self._verdict(release, "0.9.0")

        assert answer["allowed"] is False
        assert answer["mustUpdate"] is True

    def test_blocked_stops_everything_including_the_newest(self, release):
        """This is the lever for a bad release: it does not wait for each
        machine to update itself."""

        answer = self._verdict(release, "1.2.0", blocked=1)

        assert answer["allowed"] is False

    def test_force_update_stops_a_version_that_would_otherwise_be_fine(self, release):
        answer = self._verdict(release, "1.1.0", force_update=1)

        assert answer["allowed"] is False
        assert answer["mustUpdate"] is True

    def test_a_version_ahead_of_the_policy_is_allowed(self, release):
        """A machine running a build newer than the server knows about is a
        developer, not an intruder — and refusing it would be refusing the
        person who is about to publish that version."""

        answer = self._verdict(release, "1.3.0")

        assert answer["allowed"] is True
        assert answer["updateAvailable"] is False

    def test_a_version_that_is_not_one_is_refused_rather_than_assumed_current(self, release):
        answer = self._verdict(release, "not-a-version")

        assert answer["allowed"] is False


class TestReadingAndWriting:
    def test_a_deployment_with_no_row_has_a_policy_anyway(self, release):
        """Nothing is installed yet, so nothing is blocked — but the shape has to
        exist before the first release, because that is when it is needed."""

        policy = asyncio.run(release.read_policy(make_env(FakeDatabase())))

        assert policy["blocked"] is False
        assert policy["minSupported"]

    def test_the_row_wins_when_there_is_one(self, release):
        env = make_env(FakeDatabase({"FROM desktop_version_policy": [a_policy(latest="2.0.0")]}))

        assert asyncio.run(release.read_policy(env))["latest"] == "2.0.0"

    def test_saving_refuses_a_minimum_above_the_latest(self, release):
        """Every installed tool would stop, including the one that is about to
        be published. A typo should not be able to do that."""

        env = make_env(FakeDatabase())

        with pytest.raises(ValueError):
            asyncio.run(release.save_policy(env, latest="1.2.0", min_supported="1.3.0", now=0))

    def test_saving_refuses_something_that_is_not_a_version(self, release):
        env = make_env(FakeDatabase())

        with pytest.raises(ValueError):
            asyncio.run(release.save_policy(env, latest="soon", min_supported="1.0.0", now=0))

    def test_saving_writes_one_row(self, release):
        """One policy, always. A second row would be a second answer to the only
        question this table exists to answer."""

        env = make_env(FakeDatabase())

        asyncio.run(release.save_policy(env, latest="1.3.0", min_supported="1.1.0", now=5))

        writes = [sql for sql, _ in env.DB.writes if "desktop_version_policy" in sql]
        assert writes and "ON CONFLICT" in writes[0]


class TestTheReleaseFileNames:
    """Flat, not one directory per version.

    electron-updater's generic provider reads `{feed}/latest.yml` and resolves
    the installer's name relative to the feed, so a versioned directory means
    writing our own update logic — which would be the part nobody can test
    without the machine it runs on. The version is in the installer's name.
    """

    @pytest.mark.parametrize(
        "file",
        [
            "latest.yml",
            "luma-video-uploader-1.2.0-setup.exe",
            "luma-video-uploader-1.2.0-setup.exe.blockmap",
        ],
    )
    def test_what_an_updater_asks_for_is_allowed(self, release, file):
        assert release.release_key(file) == f"releases/{file}"

    @pytest.mark.parametrize(
        "file",
        [
            "../../secrets.txt",
            "notes.txt",
            ".env",
            "",
            "setup.exe/../../x",
            "1.2.0/latest.yml",
            None,
        ],
    )
    def test_anything_else_is_refused(self, release, file):
        """The only public route on this Worker that is not about video. A
        pattern rather than a sanitiser: sanitising means enumerating every way
        of writing `..`, and these names are entirely predictable.

        `None` rather than an exception, matching `desktop_tools.mirror_key` next
        door — the caller turns either answer into the same 404.
        """

        assert release.release_key(file) is None
