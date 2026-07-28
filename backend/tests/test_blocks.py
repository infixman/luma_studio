"""The four block types beyond plain text, and what they need to be drawn."""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def pages():
    import pages as module

    return module


@pytest.fixture
def block_data():
    import block_data as module

    return module


MEDIA_A = "mediaidaaa1"
MEDIA_B = "mediaidbbb2"


def media_row(media_id=MEDIA_A, key="_media/a.jpg", alt="日出"):
    return {
        "id": media_id,
        "object_key": key,
        "file_name": "a.jpg",
        "alt": alt,
        "byte_size": 100,
        "created_at": 1700000000,
    }


def product_row(product_id="p1", slug="kit", status="active", position=0):
    return {
        "id": product_id,
        "slug": slug,
        "title": "材料包",
        "description": "",
        "status": status,
        "position": position,
        "created_at": 1700000000,
        "updated_at": 1700000000,
    }


def block(kind, config, block_id="b1"):
    return {"id": block_id, "type": kind, "config": config, "position": 0}


class TestCarousel:
    def test_a_slide_keeps_its_image_caption_and_link(self, pages):
        _, config = pages.validate_block(
            "carousel",
            {"slides": [{"mediaId": MEDIA_A, "caption": "春天", "href": "https://example.com"}]},
        )
        assert config["slides"] == [{"mediaId": MEDIA_A, "caption": "春天", "href": "https://example.com"}]

    def test_autoplay_is_off_unless_asked_for(self, pages):
        """Something that moves on its own takes the page away from the reader."""

        _, config = pages.validate_block("carousel", {"slides": []})
        assert config["autoplay"] is False

    def test_a_ratio_outside_the_fixed_set_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("carousel", {"slides": [], "ratio": "16:9"})

    def test_a_slide_whose_image_was_deleted_can_still_be_saved(self, pages):
        """Otherwise the block cannot be repaired, only abandoned."""

        _, config = pages.validate_block("carousel", {"slides": [{"mediaId": ""}]})
        assert config["slides"][0]["mediaId"] == ""

    def test_a_javascript_link_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("carousel", {"slides": [{"mediaId": MEDIA_A, "href": "javascript:alert(1)"}]})

    def test_too_many_slides_are_refused(self, pages):
        slides = [{"mediaId": MEDIA_A}] * (pages.MAX_SLIDES + 1)
        with pytest.raises(pages.PageError):
            pages.validate_block("carousel", {"slides": slides})

    def test_slides_must_be_a_list(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("carousel", {"slides": {"mediaId": MEDIA_A}})


class TestAlbum:
    def test_empty_ids_are_dropped(self, pages):
        _, config = pages.validate_block("album", {"mediaIds": [MEDIA_A, "", MEDIA_B]})
        assert config["mediaIds"] == [MEDIA_A, MEDIA_B]

    def test_columns_come_from_a_fixed_set(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("album", {"mediaIds": [], "columns": 7})

    def test_the_defaults_are_a_three_wide_grid_of_squares(self, pages):
        _, config = pages.validate_block("album", {"mediaIds": []})
        assert (config["columns"], config["ratio"]) == (3, "square")


class TestShopBlock:
    def test_named_products_are_kept_in_the_order_given(self, pages):
        _, config = pages.validate_block("shop", {"source": "products", "slugs": ["b", "a"]})
        assert config["slugs"] == ["b", "a"]

    def test_a_category_filter_is_stored_as_typed(self, pages):
        """`,` is any and `+` is all — the same grammar as the category URLs."""

        _, config = pages.validate_block("shop", {"source": "category", "filter": "kits+gifts"})
        assert config["filter"] == "kits+gifts"

    def test_a_source_outside_the_fixed_set_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("shop", {"source": "everything"})

    def test_the_limit_is_clamped_rather_than_refused(self, pages):
        _, config = pages.validate_block("shop", {"limit": 9999})
        assert config["limit"] == pages.MAX_SHOP_ITEMS
        _, config = pages.validate_block("shop", {"limit": 0})
        assert config["limit"] == pages.MAX_SHOP_ITEMS


class TestAboutBlock:
    def test_a_link_without_a_url_is_dropped(self, pages):
        """A label with no URL is a button that does nothing."""

        _, config = pages.validate_block(
            "about",
            {"links": [{"label": "IG", "url": "https://example.com"}, {"label": "空的", "url": ""}]},
        )
        assert config["links"] == [{"label": "IG", "url": "https://example.com"}]

    def test_the_image_side_comes_from_a_fixed_set(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("about", {"imageSide": "middle"})

    def test_an_oversized_body_is_refused(self, pages):
        with pytest.raises(pages.PageError):
            pages.validate_block("about", {"body": "字" * (pages.MAX_ABOUT_BODY + 1)})


class TestHydratingPictures:
    def test_every_block_on_a_page_asks_for_its_images_once(self, block_data):
        """One query for the page, not one per block."""

        database = FakeDatabase({"WHERE id IN": [media_row(MEDIA_A), media_row(MEDIA_B, "_media/b.jpg", "")]})
        blocks = [
            block("carousel", {"slides": [{"mediaId": MEDIA_A, "caption": "", "href": ""}]}),
            block("album", {"mediaIds": [MEDIA_A, MEDIA_B]}, "b2"),
        ]
        asyncio.run(block_data.hydrate(make_env(database), blocks))
        lookups = [statement for statement in database.statements if "WHERE id IN" in statement]
        assert len(lookups) == 1

    def test_a_slide_whose_image_is_gone_is_dropped_not_drawn_empty(self, block_data):
        database = FakeDatabase({"WHERE id IN": [media_row(MEDIA_A)]})
        blocks = [
            block(
                "carousel",
                {"slides": [{"mediaId": MEDIA_A, "caption": "", "href": ""}, {"mediaId": "goneaway123", "caption": ""}]},
            )
        ]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        assert len(hydrated[0]["data"]["slides"]) == 1
        assert hydrated[0]["data"]["slides"][0]["image"]["path"] == "/media-assets/a.jpg"

    def test_the_config_is_left_exactly_as_stored(self, block_data):
        """The editor sends it straight back, so hydration must not touch it."""

        database = FakeDatabase({"WHERE id IN": []})
        config = {"slides": [{"mediaId": "goneaway123", "caption": "", "href": ""}]}
        hydrated = asyncio.run(block_data.hydrate(make_env(database), [block("carousel", config)]))
        assert hydrated[0]["config"] == config

    def test_an_album_keeps_the_order_it_was_given(self, block_data):
        database = FakeDatabase({"WHERE id IN": [media_row(MEDIA_B, "_media/b.jpg"), media_row(MEDIA_A)]})
        blocks = [block("album", {"mediaIds": [MEDIA_A, MEDIA_B]})]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        assert [image["id"] for image in hydrated[0]["data"]["images"]] == [MEDIA_A, MEDIA_B]

    def test_a_block_with_no_pictures_asks_for_none(self, block_data):
        database = FakeDatabase()
        asyncio.run(block_data.hydrate(make_env(database), [block("text", {"body": "hi"})]))
        assert not any("FROM media" in statement for statement in database.statements)


class TestHydratingTheShopBlock:
    def test_named_products_keep_the_owners_order(self, block_data):
        database = FakeDatabase({"WHERE slug = ?1": [product_row()]})
        blocks = [block("shop", {"source": "products", "slugs": ["second", "first"], "limit": 24})]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        asked = [write for write in database.statements if "WHERE slug = ?1" in write]
        assert len(asked) == 2
        assert len(hydrated[0]["data"]["products"]) == 2

    def test_a_product_that_is_no_longer_on_sale_is_left_out(self, block_data):
        """The block keeps naming it, so putting it back on sale brings it back."""

        database = FakeDatabase({"WHERE slug = ?1": [product_row(status="archived")]})
        blocks = [block("shop", {"source": "products", "slugs": ["kit"], "limit": 24})]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        assert hydrated[0]["data"]["products"] == []

    def test_the_limit_is_applied(self, block_data):
        database = FakeDatabase({"WHERE slug = ?1": [product_row()]})
        blocks = [block("shop", {"source": "products", "slugs": ["a", "b", "c"], "limit": 2})]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        assert len(hydrated[0]["data"]["products"]) == 2

    def test_a_category_filter_uses_the_same_grammar_as_the_urls(self, block_data):
        database = FakeDatabase(
            {
                "FROM product_categories WHERE slug IN": [
                    {"id": "c1", "slug": "kits", "title": "材料包", "description": "", "position": 0},
                    {"id": "c2", "slug": "gifts", "title": "禮物", "description": "", "position": 1},
                ],
                "JOIN product_category_links": [product_row()],
            }
        )
        blocks = [block("shop", {"source": "category", "filter": "kits+gifts", "limit": 24})]
        asyncio.run(block_data.hydrate(make_env(database), blocks))
        joined = [statement for statement in database.statements if "JOIN product_category_links" in statement]
        assert "HAVING COUNT(DISTINCT" in joined[0]

    def test_a_filter_naming_a_category_that_is_gone_shows_nothing(self, block_data):
        """Otherwise it silently widens to whatever is left, which was not asked for."""

        database = FakeDatabase({"FROM product_categories WHERE slug IN": [
            {"id": "c1", "slug": "kits", "title": "材料包", "description": "", "position": 0}
        ]})
        blocks = [block("shop", {"source": "category", "filter": "kits+gone", "limit": 24})]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        assert hydrated[0]["data"]["products"] == []

    def test_an_unparseable_filter_shows_nothing(self, block_data):
        database = FakeDatabase()
        blocks = [block("shop", {"source": "category", "filter": "kits+gifts,mixed", "limit": 24})]
        hydrated = asyncio.run(block_data.hydrate(make_env(database), blocks))
        assert hydrated[0]["data"]["products"] == []
