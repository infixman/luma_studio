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


class TestFulfilmentAndEntitlementSchema:
    """What an order promised, and what a member is owed because of it."""

    def _entitlement(self, database, customer: str = "cust-1", course: str = "course-1", **extra):
        columns = {
            "id": f"ent-{customer}-{course}",
            "customer_id": customer,
            "course_id": course,
            "granted_at": 0,
            "access_days": None,
            "first_viewed_at": None,
            "expires_at": None,
            "revoked_at": None,
            "revoke_reason": None,
            "created_at": 0,
            "updated_at": 0,
            **extra,
        }
        names = ", ".join(columns)
        placeholders = ", ".join("?" for _ in columns)
        database.execute(
            f"INSERT INTO course_entitlements ({names}) VALUES ({placeholders})", tuple(columns.values())
        )

    def test_a_member_holds_one_entitlement_per_course(self, database):
        """Buying the same course twice grants access once. The purchases are
        both recorded, but as sources, not as a second grant."""

        self._entitlement(database)

        with pytest.raises(sqlite3.IntegrityError):
            self._entitlement(database)

    def test_a_member_may_hold_several_different_courses(self, database):
        self._entitlement(database, course="course-1")
        self._entitlement(database, course="course-2")

        assert database.execute("SELECT COUNT(*) FROM course_entitlements").fetchone()[0] == 2

    def test_one_payment_event_cannot_grant_the_same_thing_twice(self, database):
        """The unique key is the provision key: a resent payment callback runs
        the same INSERT and is ignored rather than doubling anything."""

        self._entitlement(database)
        database.execute(
            "INSERT INTO course_entitlement_sources"
            " (id, entitlement_id, source_kind, source_order_fulfillment_id, created_at)"
            " VALUES ('s1', 'ent-cust-1-course-1', 'purchase', 'ff-1', 0)"
        )

        with pytest.raises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO course_entitlement_sources"
                " (id, entitlement_id, source_kind, source_order_fulfillment_id, created_at)"
                " VALUES ('s2', 'ent-cust-1-course-1', 'purchase', 'ff-1', 0)"
            )

    def test_gifts_are_not_forced_to_invent_a_fulfilment_to_point_at(self, database):
        """A gift has no order behind it, so the fulfilment id is null — and
        two nulls must not collide the way two equal ids would."""

        self._entitlement(database)
        for source_id in ("s1", "s2"):
            database.execute(
                "INSERT INTO course_entitlement_sources"
                " (id, entitlement_id, source_kind, source_order_fulfillment_id, actor, reason, created_at)"
                " VALUES (?, 'ent-cust-1-course-1', 'gift', NULL, 'owner@example.com', '補償', 0)",
                (source_id,),
            )

        assert database.execute("SELECT COUNT(*) FROM course_entitlement_sources").fetchone()[0] == 2

    def test_a_member_can_only_have_one_live_purchase_of_an_offer(self, database):
        """Two pending orders for the same course offer would take payment
        twice for one grant."""

        database.execute(
            "INSERT INTO course_offer_purchase_locks"
            " (customer_id, offer_id, order_id, state, expires_at, created_at, updated_at)"
            " VALUES ('cust-1', 'off-1', 'order-1', 'pending', 900, 0, 0)"
        )

        with pytest.raises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO course_offer_purchase_locks"
                " (customer_id, offer_id, order_id, state, expires_at, created_at, updated_at)"
                " VALUES ('cust-1', 'off-1', 'order-2', 'pending', 900, 0, 0)"
            )

    def test_an_order_line_records_what_it_promised_to_deliver(self, database):
        database.execute(
            "INSERT INTO orders (id, customer_id, status, subtotal, shipping_fee, total, shipping_method,"
            " recipient_name, recipient_phone, recipient_email, created_at, updated_at)"
            " VALUES ('order-1', 'cust-1', 'pending', 300, 0, 300, 'none', '甲', '', 'a@b.c', 0, 0)"
        )
        database.execute(
            "INSERT INTO order_items (id, order_id, variant_id, product_title, variant_title,"
            " unit_price, quantity, subtotal, product_id, offer_id, requires_shipping, contains_course)"
            " VALUES ('item-1', 'order-1', 'off-1', '水彩套組', '', 300, 1, 300, 'prod-1', 'off-1', 1, 1)"
        )
        database.execute(
            "INSERT INTO order_fulfillments (id, order_id, order_item_id, fulfillment_type, target_id,"
            " target_title, sku, quantity, access_days, status, created_at, updated_at)"
            " VALUES ('ff-1', 'order-1', 'item-1', 'course', 'course-1', '水彩入門', NULL, 1, 30,"
            " 'pending', 0, 0)"
        )

        promised = database.execute(
            "SELECT target_title, access_days FROM order_fulfillments WHERE order_id = 'order-1'"
        ).fetchone()
        # Snapshots: the offer can change what it grants tomorrow without
        # rewriting what this order was.
        assert promised == ("水彩入門", 30)

    def test_the_old_variant_column_is_still_there_for_existing_orders(self, database):
        columns = {row[1] for row in database.execute("PRAGMA table_info(order_items)")}

        assert "variant_id" in columns
        assert {"product_id", "offer_id", "requires_shipping", "contains_course"} <= columns


class TestVideoSchema:
    """Assets, upload sessions and transcode jobs.

    Versioned keys are the point: re-encoding an asset must be able to happen
    alongside the version members are currently watching, and only become
    live once every output is verified.
    """

    def _asset(self, database, asset_id="asset-1", status="uploading", **extra):
        columns = {
            "id": asset_id,
            "title": "第一課",
            "original_filename": "lesson-01.mp4",
            "source_key": f"sources/{asset_id}/1/source.mp4",
            "status": status,
            "byte_size": 2_000_000,
            "duration_seconds": None,
            "width": None,
            "height": None,
            "active_encode_version": None,
            "master_key": None,
            "poster_key": None,
            "error_code": None,
            "error_detail": None,
            "created_at": 0,
            "updated_at": 0,
            **extra,
        }
        names = ", ".join(columns)
        placeholders = ", ".join("?" for _ in columns)
        database.execute(f"INSERT INTO video_assets ({names}) VALUES ({placeholders})", tuple(columns.values()))

    def test_an_asset_records_where_its_source_went(self, database):
        self._asset(database)

        stored = database.execute("SELECT source_key, status FROM video_assets").fetchone()
        assert stored == ("sources/asset-1/1/source.mp4", "uploading")

    def test_an_upload_session_belongs_to_exactly_one_asset(self, database):
        self._asset(database)
        database.execute(
            "INSERT INTO video_upload_sessions (id, asset_id, upload_id, part_size, status, expires_at,"
            " created_at, updated_at) VALUES ('s1', 'asset-1', 'r2-upload-1', 16777216, 'uploading', 900, 0, 0)"
        )

        assert database.execute("SELECT COUNT(*) FROM video_upload_sessions").fetchone()[0] == 1

    def test_two_encodes_of_one_asset_can_exist_side_by_side(self, database):
        """Re-encoding must not disturb the version people are watching."""

        self._asset(database, status="ready", active_encode_version=1)
        for version in (1, 2):
            database.execute(
                "INSERT INTO video_transcode_jobs (id, asset_id, encode_version, attempt, status,"
                " started_at, finished_at, container_job_id, error_code, error_detail, created_at, updated_at)"
                " VALUES (?, 'asset-1', ?, 1, 'ready', 0, 0, NULL, NULL, NULL, 0, 0)",
                (f"job-{version}", version),
            )

        assert database.execute("SELECT COUNT(*) FROM video_transcode_jobs").fetchone()[0] == 2

    def test_one_asset_cannot_run_the_same_encode_version_twice_at_once(self, database):
        """Two containers writing the same version would race on every object."""

        self._asset(database)
        database.execute(
            "INSERT INTO video_transcode_jobs (id, asset_id, encode_version, attempt, status,"
            " started_at, finished_at, container_job_id, error_code, error_detail, created_at, updated_at)"
            " VALUES ('job-1', 'asset-1', 1, 1, 'processing', 0, NULL, NULL, NULL, NULL, 0, 0)"
        )

        with pytest.raises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO video_transcode_jobs (id, asset_id, encode_version, attempt, status,"
                " started_at, finished_at, container_job_id, error_code, error_detail, created_at, updated_at)"
                " VALUES ('job-2', 'asset-1', 1, 1, 'processing', 0, NULL, NULL, NULL, NULL, 0, 0)"
            )


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
