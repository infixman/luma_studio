"""The media library: uploads, alt text, usage and deletion."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeBucket, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def media():
    import media as module

    return module


def row(media_id="mediaid1234", key="_media/abc123.jpg", name="cat.jpg", alt="", size=1234, created=1700000000):
    return {
        "id": media_id,
        "object_key": key,
        "file_name": name,
        "alt": alt,
        "byte_size": size,
        "created_at": created,
    }


def block(config, page_id="page1", title="關於", path="/about"):
    return {"page_id": page_id, "title": title, "path": path, "config": json.dumps(config)}


class TestWhatMayBeUploaded:
    @pytest.mark.parametrize("name", ["cat.gif", "cat.svg", "cat", "cat.jpg.exe", "../secrets.jpg", "a/b.jpg"])
    def test_anything_but_a_web_image_is_refused(self, media, name):
        with pytest.raises(media.MediaError):
            media.validate_image_suffix(name)

    @pytest.mark.parametrize("name", ["cat.jpg", "CAT.JPEG", "cat.PNG", "cat.webp"])
    def test_the_three_web_formats_are_accepted_in_any_case(self, media, name):
        assert media.validate_image_suffix(name) in media.IMAGE_SUFFIXES

    def test_the_stored_name_keeps_only_the_last_segment(self, media):
        """The name is shown, never used to reach the file."""

        assert media.clean_file_name("C:\\Users\\me\\Pictures\\cat.jpg") == "cat.jpg"
        assert media.clean_file_name("/tmp/../cat.jpg") == "cat.jpg"

    def test_a_nameless_upload_still_gets_a_name(self, media):
        assert media.clean_file_name("") == "image"

    def test_a_long_name_is_cut_rather_than_refused(self, media):
        assert len(media.clean_file_name("x" * 400 + ".jpg")) == media.MAX_FILE_NAME


class TestAltText:
    def test_empty_is_a_real_answer(self, media):
        """A decorative image is better with an empty alt than with a filename."""

        assert media.validate_alt("") == ""
        assert media.validate_alt(None) == ""

    def test_too_long_is_refused(self, media):
        with pytest.raises(media.MediaError):
            media.validate_alt("字" * (media.MAX_ALT + 1))


class TestKeysAndUrls:
    def test_a_key_carries_the_prefix_that_keeps_it_out_of_the_print_routes(self, media):
        key = media.object_key(".jpg")
        assert key.startswith("_media/") and key.endswith(".jpg")

    def test_the_url_is_the_key_with_the_public_prefix(self, media):
        assert media.image_path("_media/abc.jpg") == "/media-assets/abc.jpg"

    def test_a_key_from_somewhere_else_has_no_url(self, media):
        """Only the library's own objects are reachable through its route."""

        assert media.image_path("folder/scan.jpg") is None
        assert media.image_path("_shop/photo.jpg") is None
        assert media.image_path("") is None


class TestReading:
    def test_a_row_becomes_a_url_and_the_facts_around_it(self, media):
        database = FakeDatabase({"FROM media": [row(alt="一隻貓", size=2048)]})
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert item == {
            "id": "mediaid1234",
            "path": "/media-assets/abc123.jpg",
            "fileName": "cat.jpg",
            "alt": "一隻貓",
            "byteSize": 2048,
            "createdAt": 1700000000,
        }

    def test_resolve_skips_an_id_with_nothing_behind_it(self, media):
        """A block asking for a deleted image drops that picture, not the page."""

        database = FakeDatabase({"WHERE id IN": [row()]})
        found = asyncio.run(media.resolve(make_env(database), ["mediaid1234", "goneaway1234"]))
        assert list(found) == ["mediaid1234"]

    def test_resolve_asks_nothing_when_there_is_nothing_to_ask(self, media):
        database = FakeDatabase()
        assert asyncio.run(media.resolve(make_env(database), ["", None])) == {}
        assert database.statements == []

    def test_resolve_asks_for_each_id_once(self, media):
        database = FakeDatabase({"WHERE id IN": [row()]})
        asyncio.run(media.resolve(make_env(database), ["a", "b", "a"]))
        assert "?3" not in database.statements[0]


class TestUsage:
    """Which pages use an image, read out of the block configs themselves."""

    def test_an_id_nested_anywhere_in_the_config_counts(self, media):
        database = FakeDatabase({"FROM page_blocks": [block({"items": [{"mediaId": "mediaid1234"}]})]})
        used = asyncio.run(media.usage(make_env(database), "mediaid1234"))
        assert used == [{"id": "page1", "title": "關於", "path": "/about"}]

    def test_an_id_that_is_only_part_of_a_longer_string_does_not_count(self, media):
        """The reason this reads JSON instead of running a LIKE over it."""

        database = FakeDatabase({"FROM page_blocks": [block({"body": "見 mediaid1234567 的說明"})]})
        assert asyncio.run(media.usage(make_env(database), "mediaid1234")) == []

    def test_a_page_using_an_image_twice_is_named_once(self, media):
        database = FakeDatabase(
            {
                "FROM page_blocks": [
                    block({"mediaId": "mediaid1234"}),
                    block({"items": ["mediaid1234"]}),
                ]
            }
        )
        assert len(asyncio.run(media.usage(make_env(database), "mediaid1234"))) == 1

    def test_a_block_whose_config_will_not_parse_is_skipped(self, media):
        """One unreadable row must not hide the pages that do use the image."""

        broken = {"page_id": "p0", "title": "壞掉", "path": "/broken", "config": "{not json"}
        database = FakeDatabase({"FROM page_blocks": [broken, block({"mediaId": "mediaid1234"})]})
        assert [page["id"] for page in asyncio.run(media.usage(make_env(database), "mediaid1234"))] == ["page1"]


class TestWriting:
    def test_creating_stores_the_key_and_reads_the_row_back(self, media):
        database = FakeDatabase({"FROM media": [row()]})
        item = asyncio.run(
            media.create(
                make_env(database), object_key="_media/abc123.jpg", file_name="cat.jpg", alt="", byte_size=1234
            )
        )
        insert = [write for write in database.writes if "INSERT INTO media" in write[0]]
        assert len(insert) == 1
        assert insert[0][1][1] == "_media/abc123.jpg"
        assert item["path"] == "/media-assets/abc123.jpg"

    def test_deleting_reports_the_key_that_is_now_unreferenced(self, media):
        database = FakeDatabase({"SELECT object_key": [{"object_key": "_media/abc123.jpg"}]})
        key = asyncio.run(media.delete(make_env(database), "mediaid1234"))
        assert key == "_media/abc123.jpg"
        assert any("DELETE FROM media" in write[0] for write in database.writes)

    def test_deleting_something_that_is_not_there_deletes_nothing(self, media):
        database = FakeDatabase()
        assert asyncio.run(media.delete(make_env(database), "mediaid1234")) is None
        assert not any("DELETE FROM media" in write[0] for write in database.writes)


# --- the admin endpoints -------------------------------------------------


class FakeUpload:
    def __init__(self, name: str, content: bytes):
        self.name = name
        self._content = content

    async def bytes(self):
        return self._content


class FakeForm:
    def __init__(self, fields: dict):
        self._fields = fields

    def get(self, name):
        return self._fields.get(name)


class UploadRequest(FakeRequest):
    def __init__(self, path: str, fields: dict, method: str = "POST"):
        super().__init__(path, method, {"Origin": ADMIN_ORIGIN}, host="admin-api.luma-studio.tw")
        self._fields = fields

    async def form_data(self):
        return FakeForm(self._fields)


class JsonRequest(FakeRequest):
    def __init__(self, path: str, body, method: str = "PUT"):
        super().__init__(path, method, {"Origin": ADMIN_ORIGIN}, host="admin-api.luma-studio.tw")
        self._body = body

    async def json(self):
        return self._body


def call(request, database=None, bucket=None):
    """One request straight into the handler.

    The signed-in check belongs to admin_main and is tested there; these are
    about what the handler does once it has been let through.
    """

    import media_admin_api
    from responses import Ctx
    from urllib.parse import parse_qs, urlsplit

    parts = urlsplit(request.url)
    env = make_env(database or FakeDatabase(), bucket or FakeBucket())
    ctx = Ctx(env, request, parts.path, parse_qs(parts.query))
    return asyncio.run(media_admin_api.handle(ctx))


def body_of(response):
    return json.loads(response.body)


class TestUploadEndpoint:
    def test_an_upload_stores_the_object_then_the_row(self, media):
        """That order, so a failure leaves storage rather than a broken library."""

        database = FakeDatabase({"FROM media": [row()]})
        bucket = FakeBucket()
        response = call(UploadRequest("/api/media", {"file": FakeUpload("cat.jpg", b"x" * 10)}), database, bucket)
        assert response.status == 201
        assert len(bucket.objects) == 1
        assert list(bucket.objects)[0].startswith("_media/")
        assert body_of(response)["item"]["path"].startswith("/media-assets/")

    def test_an_upload_with_no_file_is_refused(self, media):
        response = call(UploadRequest("/api/media", {}))
        assert response.status == 400

    def test_a_file_that_is_not_a_web_image_never_reaches_the_bucket(self, media):
        bucket = FakeBucket()
        response = call(UploadRequest("/api/media", {"file": FakeUpload("payload.svg", b"<svg/>")}), bucket=bucket)
        assert response.status == 400
        assert bucket.objects == {}

    def test_an_empty_file_is_refused(self, media):
        response = call(UploadRequest("/api/media", {"file": FakeUpload("cat.jpg", b"")}))
        assert response.status == 400

    def test_a_file_over_the_limit_is_refused(self, media):
        big = b"x" * (media.MAX_IMAGE_BYTES + 1)
        response = call(UploadRequest("/api/media", {"file": FakeUpload("cat.jpg", big)}))
        assert response.status == 400


class TestAltEndpoint:
    def test_alt_text_can_be_changed(self, media):
        database = FakeDatabase({"FROM media": [row(alt="一隻貓")]}, {"UPDATE media": 1})
        response = call(JsonRequest("/api/media/mediaid1234", {"alt": "  一隻貓  "}), database)
        assert response.status == 200
        update = [write for write in database.writes if "UPDATE media" in write[0]]
        assert update[0][1] == ("mediaid1234", "一隻貓")

    def test_changing_alt_on_something_that_is_gone_is_a_404(self, media):
        database = FakeDatabase(changes={"UPDATE media": 0})
        assert call(JsonRequest("/api/media/mediaid1234", {"alt": "x"}), database).status == 404

    def test_an_id_that_could_not_be_ours_is_refused_before_any_query(self, media):
        database = FakeDatabase()
        assert call(JsonRequest("/api/media/../../etc", {"alt": "x"}), database).status == 400
        assert database.statements == []


class TestDeleteEndpoint:
    def test_an_unused_image_goes_from_the_row_and_the_bucket(self, media):
        database = FakeDatabase({"SELECT object_key": [{"object_key": "_media/abc123.jpg"}]})
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(JsonRequest("/api/media/mediaid1234", None, "DELETE"), database, bucket)
        assert response.status == 200
        assert bucket.deleted == ["_media/abc123.jpg"]

    def test_an_image_a_page_uses_is_not_deleted_by_accident(self, media):
        """The answer says where it is used; deleting it takes a second ask."""

        database = FakeDatabase(
            {
                "FROM page_blocks": [block({"mediaId": "mediaid1234"})],
                "SELECT object_key": [{"object_key": "_media/abc123.jpg"}],
            }
        )
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(JsonRequest("/api/media/mediaid1234", None, "DELETE"), database, bucket)
        assert response.status == 409
        assert body_of(response)["usedBy"][0]["path"] == "/about"
        assert bucket.deleted == []

    def test_saying_so_twice_deletes_it_anyway(self, media):
        """Otherwise an image could only be removed by editing every page first."""

        database = FakeDatabase(
            {
                "FROM page_blocks": [block({"mediaId": "mediaid1234"})],
                "SELECT object_key": [{"object_key": "_media/abc123.jpg"}],
            }
        )
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(JsonRequest("/api/media/mediaid1234?force=1", None, "DELETE"), database, bucket)
        assert response.status == 200
        assert bucket.deleted == ["_media/abc123.jpg"]


class TestPublicImageRoute:
    def test_a_key_the_library_does_not_know_is_not_served(self, media):
        """The bucket also holds ibon print jobs. The URL is not the authority."""

        database = FakeDatabase()
        assert asyncio.run(media.key_is_known(make_env(database), "_media/guessed.jpg")) is False

    def test_a_key_the_library_knows_is_served(self, media):
        database = FakeDatabase({"FROM media WHERE object_key": [{"1": 1}]})
        assert asyncio.run(media.key_is_known(make_env(database), "_media/abc123.jpg")) is True
