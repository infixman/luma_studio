"""Run the migration list against a real SQLite engine.

Every other migration test asserts the SQL *text*. That catches a typo in a
table name and nothing else: a statement SQLite refuses, or an index that
parses but does not constrain anything, passes a string check happily.

D1 is SQLite, so a real `sqlite3` connection is a usable stand-in for the one
property these tests care about — whether the engine accepts the statement and
enforces what it claims. It is not a stand-in for D1 itself: nothing here
proves what the deployed database already contains, which is why the staging
comparison in the phase 1 task list stays open.
"""

import sqlite3

import pytest


@pytest.fixture
def migrations():
    from shared import migrations as module

    return module


def apply_all(connection, migrations, *, up_to: str | None = None) -> None:
    """Replay the list the way `_apply_one` does, against a real engine.

    A misspelt `up_to` used to mean "apply everything", which is the one
    outcome a test asking for a partial schema must not silently get.
    """

    names = [migration["name"] for migration in migrations.MIGRATIONS]
    if up_to is not None and up_to not in names:
        raise AssertionError(f"no such migration: {up_to}")

    for migration in migrations.MIGRATIONS:
        for table, column, definition in migration.get("add_columns", ()):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        for statement in migration["statements"]:
            connection.execute(statement)
        if up_to is not None and migration["name"] == up_to:
            return


@pytest.fixture
def database(migrations):
    connection = sqlite3.connect(":memory:")
    apply_all(connection, migrations)
    yield connection
    connection.close()


def test_every_migration_statement_is_valid_sqlite(database):
    """Reaching the fixture at all means the engine accepted all of them."""

    tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"products", "product_variants", "orders", "order_items"} <= tables


class TestOneDefaultOfferPerProduct:
    """Phase 0 left open whether a partial unique index can be relied on.

    It can: SQLite has supported them since 3.8, and the index below refuses
    the second row rather than merely documenting the intent. The API-side
    invariant stays as well, because the index cannot help a product whose
    rows are written by two isolates racing on different statements.
    """

    def _product(self, database, product_id: str = "p" * 18) -> str:
        database.execute(
            "INSERT INTO products (id, slug, title, description, status, position, created_at, updated_at)"
            " VALUES (?, ?, 'Brush', '', 'active', 0, 0, 0)",
            (product_id, f"slug-{product_id[:4]}"),
        )
        return product_id

    def _offer(self, database, product_id: str, offer_id: str, *, is_default: int) -> None:
        database.execute(
            "INSERT INTO product_variants"
            " (id, product_id, title, sku, price, stock, position, enabled, is_default)"
            " VALUES (?, ?, '', '', 300, 1, 0, 1, ?)",
            (offer_id, product_id, is_default),
        )

    def test_a_second_default_offer_is_refused_by_the_database(self, database):
        product_id = self._product(database)
        self._offer(database, product_id, "v" * 18, is_default=1)

        with pytest.raises(sqlite3.IntegrityError):
            self._offer(database, product_id, "w" * 18, is_default=1)

    def test_non_default_offers_are_not_constrained(self, database):
        """The index is partial: it must not turn into "one offer per product"."""

        product_id = self._product(database)
        self._offer(database, product_id, "v" * 18, is_default=0)
        self._offer(database, product_id, "w" * 18, is_default=0)

        count = database.execute(
            "SELECT COUNT(*) FROM product_variants WHERE product_id = ?", (product_id,)
        ).fetchone()[0]
        assert count == 2

    def test_two_products_may_each_have_their_own_default(self, database):
        first = self._product(database, "a" * 18)
        second = self._product(database, "b" * 18)

        self._offer(database, first, "v" * 18, is_default=1)
        self._offer(database, second, "w" * 18, is_default=1)

        assert database.execute("SELECT COUNT(*) FROM product_variants WHERE is_default = 1").fetchone()[0] == 2


class TestComposableOfferSchema:
    """Phase 2 splits what is sold from what is delivered."""

    def test_a_course_slug_cannot_be_reused(self, database):
        database.execute(
            "INSERT INTO courses (id, slug, title, status, created_at, updated_at)"
            " VALUES ('c1', 'watercolour', 'A', 'draft', 0, 0)"
        )

        with pytest.raises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO courses (id, slug, title, status, created_at, updated_at)"
                " VALUES ('c2', 'watercolour', 'B', 'draft', 0, 0)"
            )

    def test_the_same_target_cannot_be_added_to_one_offer_twice(self, database):
        """Wanting two of something is a quantity, not a second component."""

        database.execute(
            "INSERT INTO offer_components"
            " (id, offer_id, component_type, component_id, quantity, access_days, position)"
            " VALUES ('k1', 'offer-1', 'inventory', 'kit-1', 1, NULL, 0)"
        )

        with pytest.raises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO offer_components"
                " (id, offer_id, component_type, component_id, quantity, access_days, position)"
                " VALUES ('k2', 'offer-1', 'inventory', 'kit-1', 1, NULL, 1)"
            )

    def test_two_offers_may_share_one_inventory_item(self, database):
        for index, offer_id in enumerate(("offer-1", "offer-2")):
            database.execute(
                "INSERT INTO offer_components"
                " (id, offer_id, component_type, component_id, quantity, access_days, position)"
                " VALUES (?, ?, 'inventory', 'kit-1', 1, NULL, 0)",
                (f"c{index}", offer_id),
            )

        shared = database.execute(
            "SELECT COUNT(*) FROM offer_components WHERE component_id = 'kit-1'"
        ).fetchone()[0]
        assert shared == 2


class TestInventoryBackfill:
    """Every existing variant becomes one InventoryItem it alone points at."""

    def _seed_before_0028(self, migrations, connection) -> None:
        apply_all(connection, migrations, up_to="0027_add_default_product_offers")
        connection.execute(
            "INSERT INTO products (id, slug, title, description, status, position, created_at, updated_at)"
            " VALUES ('prod-1', 'shirt', 'T-shirt', '', 'active', 0, 0, 0)"
        )
        connection.execute(
            "INSERT INTO product_variants"
            " (id, product_id, title, sku, price, stock, position, enabled, is_default)"
            " VALUES ('off-1', 'prod-1', 'M', 'SHIRT-M', 300, 7, 0, 1, 0)"
        )
        connection.execute(
            "INSERT INTO products (id, slug, title, description, status, position, created_at, updated_at)"
            " VALUES ('prod-2', 'brush', '畫筆', '', 'active', 1, 0, 0)"
        )
        connection.execute(
            "INSERT INTO product_variants"
            " (id, product_id, title, sku, price, stock, position, enabled, is_default)"
            " VALUES ('off-2', 'prod-2', '', 'BRUSH-01', 680, 20, 0, 1, 1)"
        )

    def _apply_0028(self, migrations, connection) -> None:
        migration = next(item for item in migrations.MIGRATIONS if item["name"].startswith("0028"))
        for table, column, definition in migration.get("add_columns", ()):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        for statement in migration["statements"]:
            connection.execute(statement)

    def test_each_variant_gains_an_item_carrying_its_sku_and_stock(self, migrations):
        connection = sqlite3.connect(":memory:")
        try:
            self._seed_before_0028(migrations, connection)
            self._apply_0028(migrations, connection)

            rows = dict(
                (row[0], row[1:])
                for row in connection.execute("SELECT id, sku, stock, title FROM inventory_items")
            )
            assert rows["off-1"][:2] == ("SHIRT-M", 7)
            assert rows["off-2"][:2] == ("BRUSH-01", 20)
            # A named offer says which one it is; a default offer has no name
            # to add, and "畫筆 " with a dangling space helps nobody.
            assert rows["off-1"][2] == "T-shirt M"
            assert rows["off-2"][2] == "畫筆"
        finally:
            connection.close()

    def test_each_offer_gains_one_inventory_component(self, migrations):
        connection = sqlite3.connect(":memory:")
        try:
            self._seed_before_0028(migrations, connection)
            self._apply_0028(migrations, connection)

            rows = connection.execute(
                "SELECT offer_id, component_type, component_id, quantity, access_days"
                " FROM offer_components ORDER BY offer_id"
            ).fetchall()
            assert rows == [
                ("off-1", "inventory", "off-1", 1, None),
                ("off-2", "inventory", "off-2", 1, None),
            ]
        finally:
            connection.close()

    def test_re_running_it_neither_duplicates_rows_nor_undoes_a_stock_edit(self, migrations):
        connection = sqlite3.connect(":memory:")
        try:
            self._seed_before_0028(migrations, connection)
            self._apply_0028(migrations, connection)
            connection.execute("UPDATE inventory_items SET stock = 99 WHERE id = 'off-1'")

            self._apply_0028(migrations, connection)

            assert connection.execute("SELECT COUNT(*) FROM inventory_items").fetchone()[0] == 2
            assert connection.execute("SELECT COUNT(*) FROM offer_components").fetchone()[0] == 2
            adjusted = connection.execute("SELECT stock FROM inventory_items WHERE id = 'off-1'").fetchone()[0]
            assert adjusted == 99
        finally:
            connection.close()


class TestDefaultOfferBackfill:
    """0027 marks a product's only offer and refuses to guess for the rest."""

    def _seed_before_0027(self, migrations, connection) -> None:
        apply_all(connection, migrations, up_to="0026_add_customer_access_and_activity")
        for index, (product_id, offers) in enumerate(
            {"a" * 18: ["v1"], "b" * 18: ["w1", "w2"], "c" * 18: []}.items()
        ):
            connection.execute(
                "INSERT INTO products (id, slug, title, description, status, position, created_at, updated_at)"
                " VALUES (?, ?, 'P', '', 'active', ?, 0, 0)",
                (product_id, f"slug-{index}", index),
            )
            for offer_id in offers:
                connection.execute(
                    "INSERT INTO product_variants"
                    " (id, product_id, title, sku, price, stock, position, enabled)"
                    " VALUES (?, ?, '', '', 300, 1, 0, 1)",
                    (offer_id, product_id),
                )

    def test_only_the_single_offer_product_gains_a_default(self, migrations):
        connection = sqlite3.connect(":memory:")
        try:
            self._seed_before_0027(migrations, connection)
            migration = next(item for item in migrations.MIGRATIONS if item["name"] == "0027_add_default_product_offers")

            for table, column, definition in migration["add_columns"]:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            for statement in migration["statements"]:
                connection.execute(statement)

            marked = {row[0] for row in connection.execute("SELECT id FROM product_variants WHERE is_default = 1")}
            assert marked == {"v1"}
        finally:
            connection.close()
