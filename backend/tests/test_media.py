"""The media library: uploads, naming, tags, search, usage and deletion."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeBucket, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def media():
    import media as module

    return module


def row(
    media_id="mediaid1234",
    key="_media/abc123.jpg",
    name="cat.jpg",
    title="",
    alt="",
    tags=None,
    size=1234,
    created=1700000000,
    width=0,
    height=0,
    sizes="",
):
    return {
        "id": media_id,
        "object_key": key,
        "file_name": name,
        "title": title,
        "alt": alt,
        # How SQL hands them over: one string, newline separated.
        "tags": "\n".join(tags or ()),
        "byte_size": size,
        "width": width,
        "height": height,
        # Likewise, one line per variant, five space-separated fields.
        "sizes": sizes,
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


class TestTitle:
    """The owner's own label, which is never the alt text."""

    def test_empty_is_fine_because_the_file_name_stands_in(self, media):
        assert media.validate_title("") == ""
        assert media.validate_title(None) == ""

    def test_spacing_is_tidied_but_the_words_are_left_alone(self, media):
        assert media.validate_title("  首頁  banner  ") == "首頁 banner"

    def test_case_is_kept_because_this_one_is_read_by_people(self, media):
        """Unlike a tag: nobody matches on a title, they read it."""

        assert media.validate_title("Banner V3") == "Banner V3"

    def test_too_long_is_refused(self, media):
        with pytest.raises(media.MediaError):
            media.validate_title("字" * (media.MAX_TITLE + 1))


class TestTagNormalisation:
    def test_surrounding_and_inner_whitespace_is_reduced(self, media):
        assert media.normalise_tag("  首頁   用圖 ") == "首頁 用圖"

    def test_a_newline_cannot_survive_because_it_separates_tags_in_sql(self, media):
        assert "\n" not in media.normalise_tag("首頁\n用圖")

    def test_ascii_is_folded_so_one_tag_does_not_become_two(self, media):
        assert media.normalise_tag("Banner") == media.normalise_tag("BANNER") == "banner"

    def test_chinese_is_left_exactly_as_typed(self, media):
        assert media.normalise_tag("插畫") == "插畫"

    def test_an_over_long_tag_is_cut_rather_than_refused(self, media):
        assert len(media.normalise_tag("字" * 80)) == media.MAX_TAG

    def test_nothing_but_spaces_is_not_a_tag(self, media):
        assert media.normalise_tag("   ") == ""


class TestTagLists:
    def test_the_order_typed_is_the_order_kept(self, media):
        assert media.validate_tags(["首頁", "插畫", "banner"]) == ["首頁", "插畫", "banner"]

    def test_two_spellings_of_one_tag_are_one_tag(self, media):
        assert media.validate_tags(["Banner", " banner "]) == ["banner"]

    def test_blanks_are_dropped_rather_than_stored(self, media):
        assert media.validate_tags(["插畫", "", "   ", None]) == ["插畫"]

    def test_nothing_at_all_is_an_empty_list(self, media):
        assert media.validate_tags(None) == []

    def test_more_than_the_ceiling_is_refused(self, media):
        with pytest.raises(media.MediaError):
            media.validate_tags([f"tag{index}" for index in range(media.MAX_TAGS + 1)])

    def test_duplicates_do_not_count_towards_the_ceiling(self, media):
        assert len(media.validate_tags(["插畫"] * (media.MAX_TAGS + 5))) == 1

    def test_something_that_is_not_a_list_is_refused(self, media):
        with pytest.raises(media.MediaError):
            media.validate_tags("插畫,首頁")


class TestDimensions:
    """What the browser says it measured, which is all there is to go on."""

    def test_a_pair_of_numbers_comes_through(self, media):
        assert media.validate_dimensions("1024x768") == (1024, 768)

    def test_the_letter_between_them_may_be_upper_case(self, media):
        assert media.validate_dimensions("1024X768") == (1024, 768)

    @pytest.mark.parametrize("raw", ["", None, "1024", "1024x", "axb", "-5x10", "10.5x2", "1024x768x2"])
    def test_anything_unreadable_is_simply_unmeasured(self, media, raw):
        """Not an error: refusing would reject exactly the file most worth keeping."""

        assert media.validate_dimensions(raw) == (0, 0)

    def test_a_zero_side_is_not_a_picture(self, media):
        assert media.validate_dimensions("0x768") == (0, 0)

    def test_an_impossible_size_is_not_taken_as_fact(self, media):
        """Nothing here decodes the image, so this is the only check there is."""

        assert media.validate_dimensions(f"{media.MAX_DIMENSION + 1}x10") == (0, 0)
        assert media.validate_dimensions(f"{media.MAX_DIMENSION}x10") == (media.MAX_DIMENSION, 10)


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

    def test_a_variant_key_is_generated_rather_than_derived_from_the_original(self, media):
        """A derived key would collide with the previous version of a replaced image."""

        key = media.variant_key("small")
        assert key.startswith("_media/") and key.endswith("-small.webp")
        # Nothing about the original is in it, which is the whole point: the
        # function is not even given the original's key.
        assert "abc123" not in key

    def test_a_variant_key_survives_the_public_route_s_own_checks(self, media):
        """The srcset points a customer's browser straight at these."""

        key = media.variant_key("medium")
        assert media.image_path(key) is not None
        assert media.validate_image_suffix(key[key.rfind("/") + 1 :]) == ".webp"


class TestReading:
    def test_a_row_becomes_a_url_and_the_facts_around_it(self, media):
        database = FakeDatabase(
            {"FROM media": [row(title="首頁主圖", alt="一隻貓", tags=["插畫"], size=2048, width=1024, height=768)]}
        )
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert item == {
            "id": "mediaid1234",
            "path": "/media-assets/abc123.jpg",
            "fileName": "cat.jpg",
            "title": "首頁主圖",
            "alt": "一隻貓",
            "tags": ["插畫"],
            "byteSize": 2048,
            "width": 1024,
            "height": 768,
            "sizes": [],
            "createdAt": 1700000000,
        }

    def test_title_and_alt_stay_two_answers_to_two_questions(self, media):
        """One says what it is for the owner, the other for a screen reader."""

        database = FakeDatabase({"FROM media": [row(title="首頁 banner v3", alt="一隻在窗邊的貓")]})
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert item["title"] == "首頁 banner v3"
        assert item["alt"] == "一隻在窗邊的貓"

    def test_an_image_from_before_tags_existed_reads_as_untagged(self, media):
        """The column defaults to empty; a row with nothing in it is not an error."""

        database = FakeDatabase({"FROM media": [row(tags=[])]})
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert item["title"] == "" and item["tags"] == []

    def test_the_widths_come_back_narrowest_first(self, media):
        """The order a srcset is read in, and one group_concat does not promise."""

        joined = "\n".join(
            [
                "medium _media/bbb-medium.webp 960 720 40000",
                "small _media/aaa-small.webp 480 360 12000",
            ]
        )
        database = FakeDatabase({"FROM media": [row(width=1600, height=1200, sizes=joined)]})
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert item["sizes"] == [
            {"label": "small", "path": "/media-assets/aaa-small.webp", "width": 480, "height": 360, "byteSize": 12000},
            {
                "label": "medium",
                "path": "/media-assets/bbb-medium.webp",
                "width": 960,
                "height": 720,
                "byteSize": 40000,
            },
        ]

    def test_an_image_from_before_the_widths_existed_has_none(self, media):
        database = FakeDatabase({"FROM media": [row()]})
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert item["sizes"] == [] and item["width"] == 0 and item["height"] == 0

    def test_a_width_that_will_not_parse_costs_only_itself(self, media):
        """One bad srcset entry, not a page that fails to render."""

        joined = "\n".join(["small _media/aaa-small.webp 480 360 12000", "medium broken", "large x y z w"])
        database = FakeDatabase({"FROM media": [row(sizes=joined)]})
        item = asyncio.run(media.get_media(make_env(database), "mediaid1234"))
        assert [size["label"] for size in item["sizes"]] == ["small"]

    def test_resolve_carries_the_widths_because_that_is_what_they_are_for(self, media):
        """The storefront is the only place a srcset is ever written."""

        joined = "small _media/aaa-small.webp 480 360 12000"
        database = FakeDatabase({"WHERE id IN": [row(sizes=joined)]})
        found = asyncio.run(media.resolve(make_env(database), ["mediaid1234"]))
        assert found["mediaid1234"]["sizes"][0]["width"] == 480
        assert "FROM media_sizes" in database.statements[0]

    def test_resolve_still_leaves_the_tags_behind(self, media):
        """Nothing on the storefront renders a tag, and D1 charges per column read."""

        database = FakeDatabase({"WHERE id IN": [row()]})
        asyncio.run(media.resolve(make_env(database), ["mediaid1234"]))
        assert "FROM media_tags" not in database.statements[0]

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


class TestSearch:
    """What `q` looks in, which is the whole point of the tags being a table."""

    def test_no_term_asks_for_everything(self, media):
        database = FakeDatabase()
        asyncio.run(media.list_media(make_env(database)))
        assert "media.title LIKE" not in database.statements[0]

    def test_a_term_looks_in_the_title_the_file_name_and_the_tags(self, media):
        database = FakeDatabase()
        asyncio.run(media.list_media(make_env(database), search="貓"))
        sql = database.statements[0]
        assert "media.title LIKE ?1" in sql
        assert "media.file_name LIKE ?1" in sql
        assert "EXISTS (SELECT 1 FROM media_tags" in sql

    def test_the_words_are_matched_loosely_and_the_tag_exactly(self, media):
        """Searching 貓 must not answer with everything tagged 熊貓."""

        database = FakeDatabase()
        asyncio.run(media.list_media(make_env(database), search="貓"))
        assert "tag = ?2" in database.statements[0]
        assert database.reads[0][1][:2] == ("%貓%", "貓")

    def test_the_term_is_normalised_the_way_the_tag_was_stored(self, media):
        """Otherwise typing Banner would never find the tag banner."""

        database = FakeDatabase()
        asyncio.run(media.list_media(make_env(database), search=" Banner "))
        assert database.reads[0][1][1] == "banner"

    def test_a_very_long_term_is_cut_rather_than_sent_whole(self, media):
        database = FakeDatabase()
        asyncio.run(media.list_media(make_env(database), search="字" * 500))
        assert len(database.reads[0][1][0]) == media.MAX_SEARCH + 2  # the two % around it

    def test_spaces_alone_are_not_a_search(self, media):
        database = FakeDatabase()
        asyncio.run(media.list_media(make_env(database), search="   "))
        assert "media.title LIKE" not in database.statements[0]

    def test_the_list_says_when_it_was_cut_short(self, media):
        database = FakeDatabase({"FROM media": [row() for _ in range(media.MAX_ITEMS + 1)]})
        items, truncated = asyncio.run(media.list_media(make_env(database)))
        assert truncated is True and len(items) == media.MAX_ITEMS


class TestTagIndex:
    def test_the_tags_in_use_come_back_most_used_first(self, media):
        """Which is the order the suggestions are read in."""

        database = FakeDatabase({"FROM media_tags": [{"tag": "插畫", "uses": 9}, {"tag": "首頁", "uses": 2}]})
        assert asyncio.run(media.list_tags(make_env(database))) == ["插畫", "首頁"]
        assert "ORDER BY uses DESC" in database.statements[0]


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


class TestUsageOfSeveral:
    """The same question about a selection, which is one scan rather than ten."""

    def test_every_id_gets_an_answer_even_when_it_is_empty(self, media):
        database = FakeDatabase({"FROM page_blocks": [block({"mediaId": "mediaid1234"})]})
        found = asyncio.run(media.usage_of(make_env(database), ["mediaid1234", "otherid12345"]))
        assert [page["id"] for page in found["mediaid1234"]] == ["page1"]
        assert found["otherid12345"] == []

    def test_the_blocks_are_read_once_however_many_images_are_asked_about(self, media):
        database = FakeDatabase({"FROM page_blocks": [block({"mediaId": "mediaid1234"})]})
        asyncio.run(media.usage_of(make_env(database), [f"mediaid{index:04}" for index in range(20)]))
        assert len([sql for sql in database.statements if "FROM page_blocks" in sql]) == 1

    def test_nothing_asked_about_asks_the_database_nothing(self, media):
        database = FakeDatabase()
        assert asyncio.run(media.usage_of(make_env(database), [])) == {}
        assert database.statements == []


class TestWriting:
    def test_creating_stores_the_key_and_reads_the_row_back(self, media):
        database = FakeDatabase({"FROM media": [row()]})
        item = asyncio.run(
            media.create(
                make_env(database),
                object_key="_media/abc123.jpg",
                file_name="cat.jpg",
                title="",
                alt="",
                byte_size=1234,
            )
        )
        insert = [write for write in database.writes if "INSERT INTO media" in write[0]]
        assert len(insert) == 1
        assert insert[0][1][1] == "_media/abc123.jpg"
        assert item["path"] == "/media-assets/abc123.jpg"

    def test_saving_writes_the_title_and_the_alt_in_one_statement(self, media):
        """Two endpoints would mean a half-saved image when the second failed."""

        database = FakeDatabase()
        asyncio.run(media.update(make_env(database), "mediaid1234", title="首頁主圖", alt="一隻貓", tags=[]))
        update = [write for write in database.writes if "UPDATE media" in write[0]]
        assert update[0][1] == ("mediaid1234", "首頁主圖", "一隻貓")

    def test_saving_tags_replaces_whatever_was_there(self, media):
        database = FakeDatabase()
        asyncio.run(media.update(make_env(database), "mediaid1234", title="", alt="", tags=["插畫", "首頁"]))
        tag_writes = [write for write in database.writes if "media_tags" in write[0]]
        assert tag_writes[0][0].startswith("DELETE FROM media_tags")
        assert tag_writes[1][1] == ("mediaid1234", "插畫", "首頁")

    def test_clearing_every_tag_writes_nothing_back(self, media):
        database = FakeDatabase()
        asyncio.run(media.update(make_env(database), "mediaid1234", title="", alt="", tags=[]))
        assert not any("INSERT OR IGNORE INTO media_tags" in write[0] for write in database.writes)

    def test_saving_something_that_is_gone_touches_no_tags(self, media):
        """Otherwise a stale id would leave tag rows behind with no image."""

        database = FakeDatabase(changes={"UPDATE media": 0})
        assert asyncio.run(media.update(make_env(database), "gone12345678", title="", alt="", tags=["插畫"])) is False
        assert not any("media_tags" in write[0] for write in database.writes)

    def test_deleting_takes_the_tags_with_it(self, media):
        """A tag nothing carries would keep being offered by the autocomplete."""

        database = FakeDatabase({"SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}]})
        asyncio.run(media.delete(make_env(database), "mediaid1234"))
        assert any("DELETE FROM media_tags" in write[0] for write in database.writes)

    def test_deleting_reports_the_key_that_is_now_unreferenced(self, media):
        database = FakeDatabase({"SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}]})
        keys = asyncio.run(media.delete(make_env(database), "mediaid1234"))
        assert keys == ["_media/abc123.jpg"]
        assert any("DELETE FROM media" in write[0] for write in database.writes)

    def test_deleting_reports_every_width_it_was_stored_at(self, media):
        """A variant left in the bucket is storage nothing can reach again."""

        database = FakeDatabase(
            {
                "SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}],
                "FROM media_sizes WHERE media_id": [
                    {"object_key": "_media/aaa-small.webp"},
                    {"object_key": "_media/bbb-medium.webp"},
                ],
            }
        )
        keys = asyncio.run(media.delete(make_env(database), "mediaid1234"))
        assert keys == ["_media/abc123.jpg", "_media/aaa-small.webp", "_media/bbb-medium.webp"]
        assert any("DELETE FROM media_sizes" in write[0] for write in database.writes)

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


class TestUploadingTheWidthsWithIt:
    """The browser scales before it uploads; this is what arrives afterwards."""

    def test_each_width_is_stored_as_its_own_object_and_its_own_row(self, media):
        database = FakeDatabase({"FROM media": [row()]})
        bucket = FakeBucket()
        response = call(
            UploadRequest(
                "/api/media",
                {
                    "file": FakeUpload("cat.jpg", b"x" * 10),
                    "dimensions": "1600x1200",
                    "size_small": FakeUpload("small.webp", b"s" * 4),
                    "size_small_dimensions": "480x360",
                    "size_medium": FakeUpload("medium.webp", b"m" * 6),
                    "size_medium_dimensions": "960x720",
                },
            ),
            database,
            bucket,
        )
        assert response.status == 201
        assert len(bucket.objects) == 3
        insert = [write for write in database.writes if "INSERT INTO media " in write[0]]
        assert insert[0][1][6:8] == (1600, 1200)
        sizes = [write for write in database.writes if "INTO media_sizes" in write[0]]
        assert [write[1][1] for write in sizes] == ["small", "medium"]
        assert [write[1][3] for write in sizes] == [480, 960]
        # The byte size recorded is the bytes stored, not a number the browser
        # was trusted to send along with them.
        assert [write[1][5] for write in sizes] == [4, 6]

    def test_an_upload_with_no_widths_at_all_is_normal(self, media):
        """An image already narrower than the smallest target has none to give."""

        database = FakeDatabase({"FROM media": [row()]})
        bucket = FakeBucket()
        response = call(
            UploadRequest("/api/media", {"file": FakeUpload("tiny.png", b"x" * 10)}), database, bucket
        )
        assert response.status == 201
        assert len(bucket.objects) == 1
        assert not any("INTO media_sizes" in write[0] for write in database.writes)

    def test_a_width_the_caller_invented_is_not_stored(self, media):
        """The labels are read from a closed set, not from what arrived."""

        database = FakeDatabase({"FROM media": [row()]})
        bucket = FakeBucket()
        response = call(
            UploadRequest(
                "/api/media",
                {
                    "file": FakeUpload("cat.jpg", b"x" * 10),
                    "size_huge": FakeUpload("huge.webp", b"h" * 4),
                    "size_huge_dimensions": "5000x5000",
                },
            ),
            database,
            bucket,
        )
        assert response.status == 201
        assert len(bucket.objects) == 1
        assert not any("INTO media_sizes" in write[0] for write in database.writes)

    def test_an_original_the_browser_could_not_measure_is_still_kept(self, media):
        """Losing the only copy of a photo is worse than not knowing its size."""

        database = FakeDatabase({"FROM media": [row()]})
        response = call(
            UploadRequest("/api/media", {"file": FakeUpload("cat.jpg", b"x" * 10), "dimensions": "?"}), database
        )
        assert response.status == 201
        insert = [write for write in database.writes if "INSERT INTO media " in write[0]]
        assert insert[0][1][6:8] == (0, 0)

    def test_a_width_that_cannot_state_its_own_size_is_refused(self, media):
        """A srcset entry is the width; one without it is a pointless download."""

        bucket = FakeBucket()
        response = call(
            UploadRequest(
                "/api/media",
                {
                    "file": FakeUpload("cat.jpg", b"x" * 10),
                    "dimensions": "1600x1200",
                    "size_small": FakeUpload("small.webp", b"s" * 4),
                },
            ),
            bucket=bucket,
        )
        assert response.status == 400
        assert bucket.objects == {}

    def test_an_oversized_width_never_reaches_the_bucket(self, media):
        bucket = FakeBucket()
        response = call(
            UploadRequest(
                "/api/media",
                {
                    "file": FakeUpload("cat.jpg", b"x" * 10),
                    "size_small": FakeUpload("small.webp", b"s" * (media.MAX_VARIANT_BYTES + 1)),
                    "size_small_dimensions": "480x360",
                },
            ),
            bucket=bucket,
        )
        assert response.status == 400
        assert bucket.objects == {}


class TestListEndpoint:
    def test_the_search_box_reaches_the_query(self, media):
        """Client-side filtering would only ever filter the page it was given."""

        database = FakeDatabase()
        response = call(JsonRequest("/api/media?q=插畫", None, "GET"), database)
        assert response.status == 200
        assert "media.title LIKE ?1" in database.statements[0]

    def test_the_tag_list_is_reached_before_the_id_route(self, media):
        """`tags` is not an id, so the order of these two routes is load bearing."""

        database = FakeDatabase({"FROM media_tags": [{"tag": "插畫", "uses": 1}]})
        response = call(JsonRequest("/api/media/tags", None, "GET"), database)
        assert response.status == 200
        assert body_of(response)["tags"] == ["插畫"]


class TestUpdateEndpoint:
    def test_the_title_the_alt_and_the_tags_are_saved_together(self, media):
        database = FakeDatabase({"FROM media": [row(alt="一隻貓")]}, {"UPDATE media": 1})
        response = call(
            JsonRequest("/api/media/mediaid1234", {"title": " 首頁主圖 ", "alt": "  一隻貓  ", "tags": ["Banner"]}),
            database,
        )
        assert response.status == 200
        update = [write for write in database.writes if "UPDATE media" in write[0]]
        assert update[0][1] == ("mediaid1234", "首頁主圖", "一隻貓")
        insert = [write for write in database.writes if "INSERT OR IGNORE INTO media_tags" in write[0]]
        assert insert[0][1] == ("mediaid1234", "banner")

    def test_leaving_the_tags_out_clears_them_rather_than_guessing(self, media):
        """The form always sends the whole set, so an absent set is an empty one."""

        database = FakeDatabase({"FROM media": [row()]}, {"UPDATE media": 1})
        assert call(JsonRequest("/api/media/mediaid1234", {"alt": ""}), database).status == 200
        assert any("DELETE FROM media_tags" in write[0] for write in database.writes)

    def test_too_many_tags_is_refused_with_a_sentence_the_owner_can_read(self, media):
        database = FakeDatabase()
        response = call(
            JsonRequest("/api/media/mediaid1234", {"tags": [f"t{index}" for index in range(20)]}), database
        )
        assert response.status == 400
        assert str(media.MAX_TAGS) in body_of(response)["error"]

    def test_changing_something_that_is_gone_is_a_404(self, media):
        database = FakeDatabase(changes={"UPDATE media": 0})
        assert call(JsonRequest("/api/media/mediaid1234", {"alt": "x"}), database).status == 404

    def test_an_id_that_could_not_be_ours_is_refused_before_any_query(self, media):
        database = FakeDatabase()
        assert call(JsonRequest("/api/media/../../etc", {"alt": "x"}), database).status == 400
        assert database.statements == []


class TestDeleteEndpoint:
    def test_an_unused_image_goes_from_the_row_and_the_bucket(self, media):
        database = FakeDatabase({"SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}]})
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(JsonRequest("/api/media/mediaid1234", None, "DELETE"), database, bucket)
        assert response.status == 200
        assert bucket.deleted == ["_media/abc123.jpg"]

    def test_an_image_a_page_uses_is_not_deleted_by_accident(self, media):
        """The answer says where it is used; deleting it takes a second ask."""

        database = FakeDatabase(
            {
                "FROM page_blocks": [block({"mediaId": "mediaid1234"})],
                "SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}],
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
                "SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}],
            }
        )
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(JsonRequest("/api/media/mediaid1234?force=1", None, "DELETE"), database, bucket)
        assert response.status == 200
        assert bucket.deleted == ["_media/abc123.jpg"]


class TestBulkUsageEndpoint:
    """Asked before the confirm dialog, so one dialog can name everything."""

    def test_the_selection_comes_back_keyed_by_image(self, media):
        database = FakeDatabase({"FROM page_blocks": [block({"mediaId": "mediaid1234"})]})
        response = call(JsonRequest("/api/media/usage?ids=mediaid1234,otherid12345", None, "GET"), database)
        assert response.status == 200
        usage = body_of(response)["usage"]
        assert usage["mediaid1234"][0]["path"] == "/about"
        assert usage["otherid12345"] == []

    def test_it_is_reached_before_the_id_route(self, media):
        """"usage" is the right length and shape to be read as an id."""

        database = FakeDatabase()
        response = call(JsonRequest("/api/media/usage?ids=mediaid1234", None, "GET"), database)
        assert response.status == 200

    def test_an_id_that_could_not_be_ours_is_refused_before_any_query(self, media):
        database = FakeDatabase()
        assert call(JsonRequest("/api/media/usage?ids=../../etc", None, "GET"), database).status == 400
        assert database.statements == []


class TestBulkDeleteEndpoint:
    def test_the_whole_selection_goes_from_the_rows_and_the_bucket(self, media):
        database = FakeDatabase({"SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}]})
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(
            JsonRequest("/api/media/delete", {"ids": ["mediaid1234", "otherid12345"]}, "POST"), database, bucket
        )
        assert response.status == 200
        assert len(bucket.deleted) == 2

    def test_one_that_fails_does_not_take_the_rest_down_with_it(self, media):
        """The loop used to raise on the first failure, so the browser got a
        500 and said nothing had been deleted — while the rows deleted before
        it were already gone."""

        class Sulky(FakeBucket):
            async def delete(self, key):
                raise RuntimeError("bucket unavailable")

        database = FakeDatabase({"SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}]})
        response = call(
            JsonRequest("/api/media/delete", {"ids": ["mediaid1234", "otherid12345"]}, "POST"), database, Sulky()
        )
        # A file left in the bucket is not something the owner can act on, and
        # the image is gone as far as the shop is concerned.
        assert response.status == 200
        assert body_of(response)["deleted"] == 2
        assert body_of(response)["failed"] == []

    def test_one_already_gone_is_not_counted_as_deleted(self, media):
        """Two tabs open on the same library. Claiming ten when eight went is
        how the count stops meaning anything."""

        database = FakeDatabase({"SELECT object_key FROM media WHERE": []})
        response = call(
            JsonRequest("/api/media/delete", {"ids": ["mediaid1234", "otherid12345"]}, "POST"), database, FakeBucket()
        )
        assert response.status == 200
        assert body_of(response)["deleted"] == 0

    def test_anything_a_page_uses_stops_the_lot_and_says_which(self, media):
        """Discovering it halfway through would leave half a selection deleted."""

        database = FakeDatabase(
            {
                "FROM page_blocks": [block({"mediaId": "mediaid1234"})],
                "SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}],
            }
        )
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(
            JsonRequest("/api/media/delete", {"ids": ["mediaid1234", "otherid12345"]}, "POST"), database, bucket
        )
        assert response.status == 409
        assert list(body_of(response)["usage"]) == ["mediaid1234"]
        assert bucket.deleted == []

    def test_saying_so_twice_deletes_them_anyway(self, media):
        database = FakeDatabase(
            {
                "FROM page_blocks": [block({"mediaId": "mediaid1234"})],
                "SELECT object_key FROM media WHERE": [{"object_key": "_media/abc123.jpg"}],
            }
        )
        bucket = FakeBucket({"_media/abc123.jpg": object()})
        response = call(
            JsonRequest("/api/media/delete", {"ids": ["mediaid1234"], "force": True}, "POST"), database, bucket
        )
        assert response.status == 200
        assert bucket.deleted == ["_media/abc123.jpg"]

    def test_one_already_deleted_does_not_fail_the_others(self, media):
        """Two tabs open on the same library is not an error worth raising."""

        database = FakeDatabase()
        response = call(JsonRequest("/api/media/delete", {"ids": ["mediaid1234"]}, "POST"), database)
        assert response.status == 200

    def test_an_empty_selection_is_refused_rather_than_deleting_everything(self, media):
        database = FakeDatabase()
        assert call(JsonRequest("/api/media/delete", {"ids": []}, "POST"), database).status == 400

    def test_more_than_the_ceiling_is_refused(self, media):
        ids = [f"mediaid{index:05}" for index in range(media.MAX_BULK + 1)]
        response = call(JsonRequest("/api/media/delete", {"ids": ids}, "POST"))
        assert response.status == 400
        assert str(media.MAX_BULK) in body_of(response)["error"]

    def test_the_list_comes_back_filtered_the_way_it_was_asked_for(self, media):
        """Deleting from a search must not silently throw the search away."""

        database = FakeDatabase()
        call(JsonRequest("/api/media/delete?q=插畫", {"ids": ["mediaid1234"]}, "POST"), database)
        assert any("media.title LIKE ?1" in sql for sql in database.statements)


class TestPublicImageRoute:
    def test_a_key_the_library_does_not_know_is_not_served(self, media):
        """The bucket also holds ibon print jobs. The URL is not the authority."""

        database = FakeDatabase()
        assert asyncio.run(media.key_is_known(make_env(database), "_media/guessed.jpg")) is False

    def test_a_key_the_library_knows_is_served(self, media):
        database = FakeDatabase({"FROM media WHERE object_key": [{"1": 1}]})
        assert asyncio.run(media.key_is_known(make_env(database), "_media/abc123.jpg")) is True

    def test_the_widths_are_reachable_too_or_every_srcset_is_a_404(self, media):
        database = FakeDatabase()
        asyncio.run(media.key_is_known(make_env(database), "_media/aaa-small.webp"))
        assert "FROM media_sizes WHERE object_key" in database.statements[0]
