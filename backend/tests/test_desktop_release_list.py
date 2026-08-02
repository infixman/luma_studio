"""What is actually in the releases bucket, seen from the back office.

The version policy names a version; nothing until now could say whether that
version exists. The two are decided in different places — one in a form, one by
a CI job — so "current version: 0.2.0" could name a build nobody ever uploaded,
and the only way to find out was the Cloudflare dashboard.

The listing is asked for by hand rather than kept up to date. Listing a bucket
is not free, this page is opened rarely, and a snapshot that refreshes itself
would be a page that costs money while nobody is reading it. What is recorded is
whatever R2 said at that moment: a version deleted since is gone from the record
too, because a row for an object that does not exist is a row that can only
mislead.
"""

import asyncio
import types

import pytest

from conftest import FakeDatabase, make_env


NOW = 1785292800
INSTALLER = "luma-video-uploader-0.1.0-setup.exe"


class Listing:
    def __init__(self, objects, truncated=False, cursor=None):
        self.objects = objects
        self.truncated = truncated
        self.cursor = cursor


def an_object(key: str, size: int = 1024, uploaded_at: int = NOW):
    return types.SimpleNamespace(
        key=key, size=size, uploaded=types.SimpleNamespace(getTime=lambda: uploaded_at * 1000)
    )


class Bucket:
    """Answers a listing and records what was deleted."""

    def __init__(self, pages=None):
        self.pages = pages or [Listing([])]
        self.asked: list[dict] = []
        self.deleted: list[str] = []

    async def list(self, **options):
        self.asked.append(options)
        page = self.pages[min(len(self.asked) - 1, len(self.pages) - 1)]
        return page

    async def delete(self, key):
        self.deleted.append(key)


@pytest.fixture
def release():
    from domain import desktop_release as module

    return module


def env_with(database, bucket):
    return make_env(database, DESKTOP_TOOLS=bucket)


class TestRefreshingTheList:
    def test_it_records_what_the_bucket_says(self, release):
        bucket = Bucket([Listing([an_object(f"releases/{INSTALLER}", 94_690_523)])])
        database = FakeDatabase()

        found = asyncio.run(release.refresh_releases(env_with(database, bucket), now=NOW))

        assert [entry["version"] for entry in found["versions"]] == ["0.1.0"]
        assert found["versions"][0]["bytes"] == 94_690_523
        assert bucket.asked[0]["prefix"] == "releases/"

    def test_a_version_that_is_gone_leaves_no_record(self, release):
        """The whole point of asking again. A row for an object that does not
        exist can only mislead — and the copy-this-URL beside it would hand out
        a link to a 404."""

        database = FakeDatabase()
        asyncio.run(release.refresh_releases(env_with(database, Bucket()), now=NOW))

        wiped = [write for write in database.writes if "DELETE FROM desktop_releases" in write[0]]
        assert wiped, "the previous snapshot was left in place"

    def test_the_installer_and_its_blockmap_are_one_version(self, release):
        """Two objects, one thing somebody deletes. A list that shows them
        apart invites deleting half a release."""

        bucket = Bucket(
            [
                Listing(
                    [
                        an_object(f"releases/{INSTALLER}", 900),
                        an_object(f"releases/{INSTALLER}.blockmap", 100),
                    ]
                )
            ]
        )

        found = asyncio.run(release.refresh_releases(env_with(FakeDatabase(), bucket), now=NOW))

        assert len(found["versions"]) == 1
        assert found["versions"][0]["bytes"] == 1000
        assert sorted(found["versions"][0]["files"]) == sorted([INSTALLER, f"{INSTALLER}.blockmap"])

    def test_the_feed_is_reported_but_is_not_a_version(self, release):
        """`latest.yml` is what every updater reads and belongs to no version.
        Offering it as one would mean offering to delete it."""

        bucket = Bucket([Listing([an_object("releases/latest.yml", 400), an_object(f"releases/{INSTALLER}")])])

        found = asyncio.run(release.refresh_releases(env_with(FakeDatabase(), bucket), now=NOW))

        assert [entry["version"] for entry in found["versions"]] == ["0.1.0"]
        assert found["hasFeed"] is True

    def test_something_nobody_published_is_ignored(self, release):
        """The bucket is ours, but a stray object should not become a version
        somebody can be offered a download link to."""

        bucket = Bucket([Listing([an_object("releases/notes.txt"), an_object("releases/setup.exe")])])
        database = FakeDatabase()

        found = asyncio.run(release.refresh_releases(env_with(database, bucket), now=NOW))

        assert found["versions"] == []
        # And nothing was written down either. Grouping already drops anything
        # with no version, so a list that looks right can still be sitting on a
        # table full of objects this page has no business knowing about.
        assert [write for write in database.writes if "INSERT INTO desktop_releases" in write[0]] == []

    def test_it_follows_the_pages(self, release):
        first = Listing([an_object(f"releases/{INSTALLER}")], truncated=True, cursor="next")
        second = Listing([an_object("releases/luma-video-uploader-0.2.0-setup.exe")])
        bucket = Bucket([first, second])

        found = asyncio.run(release.refresh_releases(env_with(FakeDatabase(), bucket), now=NOW))

        assert [entry["version"] for entry in found["versions"]] == ["0.2.0", "0.1.0"]

    def test_the_newest_version_is_first(self, release):
        """Sorted as versions, not as text: `0.10.0` is newer than `0.9.0` and
        sorts before it only if somebody compares the numbers."""

        bucket = Bucket(
            [
                Listing(
                    [
                        an_object("releases/luma-video-uploader-0.9.0-setup.exe"),
                        an_object("releases/luma-video-uploader-0.10.0-setup.exe"),
                    ]
                )
            ]
        )

        found = asyncio.run(release.refresh_releases(env_with(FakeDatabase(), bucket), now=NOW))

        assert [entry["version"] for entry in found["versions"]] == ["0.10.0", "0.9.0"]


class TestReadingTheRecord:
    def test_it_answers_from_the_database_without_touching_the_bucket(self, release):
        bucket = Bucket()
        database = FakeDatabase(
            {
                "FROM desktop_releases": [
                    {"file": INSTALLER, "version": "0.1.0", "byte_size": 900, "uploaded_at": NOW, "refreshed_at": NOW},
                    {
                        "file": f"{INSTALLER}.blockmap",
                        "version": "0.1.0",
                        "byte_size": 100,
                        "uploaded_at": NOW,
                        "refreshed_at": NOW,
                    },
                ]
            }
        )

        found = asyncio.run(release.recorded_releases(env_with(database, bucket)))

        assert [entry["version"] for entry in found["versions"]] == ["0.1.0"]
        assert found["versions"][0]["bytes"] == 1000
        assert found["refreshedAt"] == NOW
        assert bucket.asked == []

    def test_the_feed_is_still_reported_from_the_record(self, release):
        """`hasFeed` has to survive being written down. Read only from the
        listing it would go missing the moment the page was reopened, and
        "沒有 latest.yml" is the one line on this page that says no installed
        tool can hear about a new build."""

        database = FakeDatabase(
            {
                "FROM desktop_releases": [
                    {"file": "latest.yml", "version": "", "byte_size": 400, "uploaded_at": NOW, "refreshed_at": NOW}
                ]
            }
        )

        found = asyncio.run(release.recorded_releases(env_with(database, Bucket())))

        assert found["hasFeed"] is True
        assert found["versions"] == []

    def test_never_asked_is_not_the_same_as_nothing_there(self, release):
        """An empty list under "no releases" would be a claim; this page has
        not looked yet."""

        found = asyncio.run(release.recorded_releases(env_with(FakeDatabase(), Bucket())))

        assert found["versions"] == []
        assert found["refreshedAt"] is None


class TestDeletingAVersion:
    def _delete(self, release, version, *, policy_latest="0.9.0", files=None):
        bucket = Bucket()
        # `is None`, not `or`: one test declares an empty record on purpose, and
        # an empty list is falsy — written as `files or [...]` it silently got
        # the default two files and the test passed for nothing.
        recorded = [INSTALLER, f"{INSTALLER}.blockmap"] if files is None else files
        database = FakeDatabase(
            {
                "FROM desktop_releases": [
                    {"file": name, "version": version, "byte_size": 1, "uploaded_at": NOW, "refreshed_at": NOW}
                    for name in recorded
                ],
                # The columns migration 0038 actually created. Named wrongly here
                # first, which made the two refusals fail as a KeyError rather
                # than as the refusal they are.
                "FROM desktop_version_policy": [
                    {
                        "id": 1,
                        "latest": policy_latest,
                        "min_supported": "0.0.1",
                        "force_update": 0,
                        "blocked": 0,
                        "notes": "",
                        "updated_at": NOW,
                    }
                ],
            }
        )
        return bucket, database, asyncio.run(
            release.delete_release(env_with(database, bucket), version=version)
        )

    def test_it_removes_every_object_of_that_version(self, release):
        bucket, _database, result = self._delete(release, "0.1.0")

        assert sorted(bucket.deleted) == sorted(
            [f"releases/{INSTALLER}", f"releases/{INSTALLER}.blockmap"]
        )
        assert result["deleted"] == 2

    def test_the_record_goes_with_the_objects(self, release):
        _bucket, database, _result = self._delete(release, "0.1.0")

        assert any("DELETE FROM desktop_releases" in write[0] for write in database.writes)

    def test_the_version_the_policy_points_at_is_refused(self, release):
        """Every installed tool is being told to update to it. Removing the
        installer leaves them all downloading a 404, and nothing about the
        policy would look wrong."""

        with pytest.raises(ValueError):
            self._delete(release, "0.1.0", policy_latest="0.1.0")

    def test_the_floor_the_policy_names_is_refused_too(self, release):
        """`minSupported` is a number the policy points at, and a policy
        pointing at something absent is the exact confusion this page exists to
        clear up."""

        with pytest.raises(ValueError):
            self._delete(release, "0.0.1", files=["luma-video-uploader-0.0.1-setup.exe"])

    def test_a_version_nothing_recorded_is_refused_rather_than_guessed(self, release):
        """The keys come from the record, so a version with no record has no
        keys — and building them from the version number would be this module
        inventing filenames the build might never have produced."""

        with pytest.raises(LookupError):
            self._delete(release, "0.1.0", files=[])

    def test_something_that_is_not_a_version_is_refused_before_anything_is_read(self, release):
        """The feed's row carries no version on purpose, so a caller asking to
        delete "" would match it. Nothing in the page sends that — which is
        exactly why the rule cannot live in the page."""

        with pytest.raises(ValueError):
            self._delete(release, "", files=["latest.yml"])

    def test_the_same_version_spelled_differently_is_still_refused(self, release):
        """electron-builder writes `1.2` in some places and `1.2.0` in others,
        and the policy's field is typed by hand. Compared as text, `0.9` beside
        `0.9.0` is the guard quietly not applying."""

        with pytest.raises(ValueError):
            self._delete(
                release, "0.9.0", policy_latest="0.9", files=["luma-video-uploader-0.9.0-setup.exe"]
            )

    def test_the_feed_is_not_deletable_through_this(self, release):
        """`latest.yml` belongs to no version. It is only reachable here if the
        version parsing let it through, which is what this pins."""

        bucket, _database, _result = self._delete(release, "0.1.0", files=[INSTALLER, "latest.yml"])

        assert "releases/latest.yml" not in bucket.deleted
