"""Category filters, and the line between a filter and a query language."""

import asyncio

import pytest

from conftest import ADMIN_ORIGIN, STOREFRONT_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def categories():
    from domain import categories as module

    return module


def product_record(product_id="p1", slug="soda-tote", status="active"):
    return {
        "id": product_id,
        "slug": slug,
        "title": "蘇打托特包",
        "description": "",
        "status": status,
        "position": 0,
        "created_at": 1,
        "updated_at": 1,
    }


def category_record(category_id="c1", slug="art-kits", title="材料包"):
    return {
        "id": category_id,
        "slug": slug,
        "title": title,
        "description": "",
        "position": 0,
        "created_at": 1,
        "updated_at": 1,
    }


class TestReadingAFilter:
    def test_a_single_slug_is_an_any_filter_of_one(self, categories):
        assert categories.parse_filter("art-kits") == (["art-kits"], categories.ANY_OF)

    def test_a_comma_means_either(self, categories):
        assert categories.parse_filter("art-kits,candles") == (["art-kits", "candles"], categories.ANY_OF)

    def test_a_plus_means_both(self, categories):
        assert categories.parse_filter("art-kits+gift") == (["art-kits", "gift"], categories.ALL_OF)

    def test_mixing_the_separators_is_refused(self, categories):
        """Giving `a,b+c` a meaning turns this into a query language.

        And a query language has to be expressible in the back office, which
        is where the cost actually lands.
        """

        with pytest.raises(ValueError):
            categories.parse_filter("a,b+c")

    def test_a_repeated_slug_is_collapsed(self, categories):
        # Left in, a duplicate makes the AND count unreachable and means
        # nothing at all for OR.
        assert categories.parse_filter("a+a") == (["a"], categories.ALL_OF)

    def test_more_than_five_is_refused(self, categories):
        with pytest.raises(ValueError):
            categories.parse_filter(",".join(f"c{index}" for index in range(6)))

    @pytest.mark.parametrize("raw", ["", "   ", ",", "+", "Not_A_Slug", "-lead"])
    def test_shapes_that_are_not_filters_are_refused(self, categories, raw):
        with pytest.raises(ValueError):
            categories.parse_filter(raw)


class TestNamingACombination:
    def test_one_category_keeps_its_own_title(self, categories):
        assert categories.filter_title([{"title": "材料包"}], categories.ANY_OF) == "材料包"

    def test_either_reads_as_a_list(self, categories):
        title = categories.filter_title([{"title": "材料包"}, {"title": "蠟燭"}], categories.ANY_OF)
        assert title == "材料包、蠟燭"

    def test_both_reads_as_an_addition(self, categories):
        title = categories.filter_title([{"title": "材料包"}, {"title": "禮盒"}], categories.ALL_OF)
        assert title == "材料包 ＋ 禮盒"


class TestQuerying:
    def test_all_counts_distinct_categories(self, categories):
        """COUNT(*) would pass a product linked twice to one category.

        The primary key stops that today; a count that is only correct
        because of the key starts lying the day the key changes.
        """

        database = FakeDatabase()
        asyncio.run(categories.products_in(make_env(database), ["c1", "c2"], categories.ALL_OF))
        query = next(s for s in database.statements if "HAVING" in s)
        assert "COUNT(DISTINCT l.category_id)" in query

    def test_either_deduplicates_products(self, categories):
        database = FakeDatabase()
        asyncio.run(categories.products_in(make_env(database), ["c1", "c2"], categories.ANY_OF))
        query = next(s for s in database.statements if "product_category_links" in s)
        assert query.startswith("SELECT DISTINCT p.*")
        assert "HAVING" not in query

    @pytest.mark.parametrize("mode", ["any", "all"])
    def test_drafts_never_match(self, categories, mode):
        database = FakeDatabase()
        asyncio.run(categories.products_in(make_env(database), ["c1"], mode))
        query = next(s for s in database.statements if "product_category_links" in s)
        assert "p.status = 'active'" in query

    def test_no_categories_asks_the_database_nothing(self, categories):
        database = FakeDatabase()
        assert asyncio.run(categories.products_in(make_env(database), [], "any")) == []
        assert database.statements == []

    def test_counts_exclude_drafts(self, categories):
        database = FakeDatabase()
        asyncio.run(categories.counts(make_env(database)))
        query = next(s for s in database.statements if "COUNT(*)" in s)
        assert "p.status = 'active'" in query


@pytest.fixture
def call():
    import main
    from shared import migrations

    def run(request, database=None):
        migrations._applied_names = None
        worker = main.Default()
        worker.env = make_env(database or FakeDatabase())
        return asyncio.run(worker.fetch(request))

    return run


class TestPublicCategoryRoutes:
    def test_the_index_is_public(self, call):
        assert call(FakeRequest("/api/categories")).status == 200

    def test_a_mixed_filter_is_not_found(self, call):
        assert call(FakeRequest("/api/categories/a,b+c")).status == 404

    def test_an_unknown_slug_is_not_found(self, call):
        database = FakeDatabase()
        assert call(FakeRequest("/api/categories/nope"), database).status == 404

    def test_a_partly_unknown_combination_is_not_found(self, call):
        """Silently dropping the half that does not exist would show the
        visitor a different set of products than the URL asked for."""

        database = FakeDatabase({"FROM product_categories WHERE slug IN": [category_record()]})
        assert call(FakeRequest("/api/categories/art-kits,ghost"), database).status == 404

    def test_a_real_but_empty_category_still_has_a_page(self, call):
        # 404 here would read as "you built the category wrong".
        database = FakeDatabase({"FROM product_categories WHERE slug IN": [category_record()]})
        response = call(FakeRequest("/api/categories/art-kits"), database)
        assert response.status == 200
        body = response.json()
        assert body["title"] == "材料包"
        assert body["products"] == []

    def test_only_a_single_category_carries_a_description(self, call):
        database = FakeDatabase(
            {
                "FROM product_categories WHERE slug IN": [
                    {**category_record("c1", "art-kits", "材料包"), "description": "手作材料"},
                    {**category_record("c2", "candles", "蠟燭"), "description": "香氛"},
                ]
            }
        )
        combined = call(FakeRequest("/api/categories/art-kits,candles"), database).json()
        assert combined["description"] == ""
        assert combined["title"] == "材料包、蠟燭"


class TestAdminCategoryRoutes:
    @pytest.fixture
    def admin_call(self):
        import admin_main
        from shared import migrations

        def run(request, answers=None):
            migrations._applied_names = None
            worker = admin_main.Default()
            worker.env = make_env(
                FakeDatabase({"SELECT email FROM admin_sessions": [{"email": "owner@example.com"}], **(answers or {})}),
                origins=ADMIN_ORIGIN,
                frontend=ADMIN_ORIGIN,
            )
            return asyncio.run(worker.fetch(request))

        return run

    def signed_in(self, path, method="GET"):
        return FakeRequest(
            path,
            method,
            {"Origin": ADMIN_ORIGIN, "x-luma-app": "1", "Cookie": "luma_admin_session=" + "a" * 40},
            host="admin-api.luma-studio.tw",
        )

    def test_the_list_is_reachable(self, admin_call):
        assert admin_call(self.signed_in("/api/categories")).status == 200

    def test_reorder_is_not_read_as_a_category_id(self, admin_call):
        """`order` sits where an id goes, so its route has to come first."""

        assert admin_call(self.signed_in("/api/categories/order", "PUT")).status == 400

    def test_an_unknown_category_is_reported_as_missing(self, admin_call):
        assert admin_call(self.signed_in("/api/categories/" + "a" * 18, "DELETE")).status == 404

    def test_categories_are_closed_without_a_session(self, admin_call):
        anonymous = FakeRequest(
            "/api/categories", "GET", {"Origin": ADMIN_ORIGIN, "x-luma-app": "1"}, host="admin-api.luma-studio.tw"
        )
        assert admin_call(anonymous).status == 401


class TestSavingAProductsCategories:
    def test_an_absent_field_leaves_them_alone(self):
        """A PUT that forgot categoryIds must not strip the product bare."""

        from api.admin import shop as shop_admin_api

        assert shop_admin_api._category_ids({"title": "x"}) is None

    def test_an_empty_list_clears_them(self):
        from api.admin import shop as shop_admin_api

        assert shop_admin_api._category_ids({"categoryIds": []}) == []

    def test_something_that_is_not_a_list_is_refused(self):
        from api.admin import shop as shop_admin_api

        with pytest.raises(ValueError):
            shop_admin_api._category_ids({"categoryIds": "c1"})
