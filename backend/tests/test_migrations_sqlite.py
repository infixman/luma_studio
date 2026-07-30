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


class TestCourseOutlineSchema:
    """Sections and lessons, and what a lesson may point at."""

    def _course(self, database, course_id="c1"):
        database.execute(
            "INSERT INTO courses (id, slug, title, status, created_at, updated_at)"
            " VALUES (?, ?, '水彩入門', 'draft', 0, 0)",
            (course_id, f"slug-{course_id}"),
        )

    def _section(self, database, section_id="s1", course_id="c1", position=0):
        database.execute(
            "INSERT INTO course_sections (id, course_id, title, position, created_at, updated_at)"
            " VALUES (?, ?, '第一章', ?, 0, 0)",
            (section_id, course_id, position),
        )

    def test_a_course_carries_the_fields_a_product_page_needs(self, database):
        self._course(database)
        database.execute(
            "UPDATE courses SET summary = ?, instructor_name = ?, level = ? WHERE id = 'c1'",
            ("兩小時學會水彩", "王老師", "beginner"),
        )

        stored = database.execute("SELECT summary, instructor_name, level FROM courses").fetchone()
        assert stored == ("兩小時學會水彩", "王老師", "beginner")

    def test_a_lesson_belongs_to_a_section_and_may_have_a_video(self, database):
        self._course(database)
        self._section(database)
        database.execute(
            "INSERT INTO course_lessons (id, section_id, title, content_html, video_asset_id,"
            " is_preview, position, created_at, updated_at)"
            " VALUES ('l1', 's1', '工具介紹', '<p>你好</p>', 'asset-1', 1, 0, 0, 0)"
        )

        stored = database.execute("SELECT video_asset_id, is_preview FROM course_lessons").fetchone()
        assert stored == ("asset-1", 1)

    def test_a_lesson_may_be_text_only(self, database):
        """Not every lesson is a video. A reading with no asset is valid."""

        self._course(database)
        self._section(database)
        database.execute(
            "INSERT INTO course_lessons (id, section_id, title, content_html, video_asset_id,"
            " is_preview, position, created_at, updated_at)"
            " VALUES ('l1', 's1', '課前準備', '<p>請準備</p>', NULL, 0, 0, 0, 0)"
        )

        assert database.execute("SELECT video_asset_id FROM course_lessons").fetchone()[0] is None

    def test_one_video_can_be_used_by_more_than_one_lesson(self, database):
        """A shared intro clip should not need uploading twice."""

        self._course(database)
        self._section(database)
        for lesson_id in ("l1", "l2"):
            database.execute(
                "INSERT INTO course_lessons (id, section_id, title, content_html, video_asset_id,"
                " is_preview, position, created_at, updated_at)"
                " VALUES (?, 's1', '片頭', '', 'asset-1', 0, 0, 0, 0)",
                (lesson_id,),
            )

        assert database.execute(
            "SELECT COUNT(*) FROM course_lessons WHERE video_asset_id = 'asset-1'"
        ).fetchone()[0] == 2


class TestProgressSchema:
    def test_a_member_has_one_position_per_lesson(self, database):
        """Two rows for one lesson would make "where was I" a coin toss."""

        database.execute(
            "INSERT INTO course_lesson_progress (customer_id, course_id, lesson_id, position_seconds,"
            " completed_at, updated_at) VALUES ('cust-1', 'c1', 'l1', 60, NULL, 0)"
        )

        with pytest.raises(sqlite3.IntegrityError):
            database.execute(
                "INSERT INTO course_lesson_progress (customer_id, course_id, lesson_id, position_seconds,"
                " completed_at, updated_at) VALUES ('cust-1', 'c1', 'l1', 90, NULL, 0)"
            )

    def test_two_members_watch_the_same_lesson_independently(self, database):
        for customer in ("cust-1", "cust-2"):
            database.execute(
                "INSERT INTO course_lesson_progress (customer_id, course_id, lesson_id, position_seconds,"
                " completed_at, updated_at) VALUES (?, 'c1', 'l1', 60, NULL, 0)",
                (customer,),
            )

        assert database.execute("SELECT COUNT(*) FROM course_lesson_progress").fetchone()[0] == 2


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


class TestSpendingAPairingCodeOnce:
    """The upsert that makes a pairing code single-use.

    `desktop_auth` checks the read row first, the way everything else in this
    codebase does — but that check loses a race, and the WHERE clause on the
    conflict is what survives one. A fake database cannot evaluate a WHERE
    clause, so this is the only place the guard is actually exercised.
    """

    def _spend(self, database, counter: int) -> int:
        # The production statement, imported rather than copied: a copy would
        # keep passing after the real one changed.
        from domain.desktop_auth import CONSUME_SQL

        cursor = database.execute(
            CONSUME_SQL.replace("?1", "'owner@example.com'").replace("?2", str(counter)).replace("?3", "0")
        )
        return cursor.rowcount

    def test_the_first_spend_takes_it(self, database):
        assert self._spend(database, 100) == 1

    def test_the_same_window_cannot_be_spent_twice(self, database):
        self._spend(database, 100)

        assert self._spend(database, 100) == 0

    def test_an_earlier_window_cannot_be_spent_afterwards(self, database):
        """Accepting the previous window is for clock skew, not for going
        backwards past something already used."""

        self._spend(database, 100)

        assert self._spend(database, 99) == 0

    def test_the_next_window_can_be(self, database):
        """A tool pairing again tomorrow is normal and must not be locked out by
        yesterday's row."""

        self._spend(database, 100)

        assert self._spend(database, 101) == 1

    def test_spending_clears_a_lock_and_the_failure_count(self, database):
        """A correct code is the end of that episode. Leaving the count where it
        was would lock the admin out on their next typo."""

        database.execute(
            "INSERT INTO desktop_pairings (email, used_counter, failures, locked_until, updated_at)"
            " VALUES ('owner@example.com', NULL, 4, 0, 0)"
        )

        self._spend(database, 100)

        row = database.execute(
            "SELECT failures, locked_until FROM desktop_pairings WHERE email = 'owner@example.com'"
        ).fetchone()
        assert row == (0, 0)

    def test_one_row_per_admin(self, database):
        self._spend(database, 100)
        self._spend(database, 101)

        count = database.execute("SELECT COUNT(*) FROM desktop_pairings").fetchone()[0]
        assert count == 1


class TestRegisteringAVerifiedEncode:
    """The statement `import` finishes with, against a database that has keys.

    The tool creates the asset first — that is what gives it an id to sign upload
    URLs for — and then calls import for the same id. So by the time this runs the
    row already exists, and a plain INSERT is a primary key collision: a 500 on
    the last step of a working upload, after every object is already in R2.

    `FakeDatabase` has no keys and no constraints, so it accepted the collision
    happily. This is the only place the statement meets one.
    """

    def _register(self, database, *, asset_id: str, title: str, version: int) -> None:
        # The production statement, imported rather than copied.
        from domain.video import REGISTER_SQL

        database.execute(
            REGISTER_SQL.replace("?1", f"'{asset_id}'")
            .replace("?2", f"'{title}'")
            .replace("?3", "'lesson.mp4'")
            .replace("?4", "8")
            .replace("?5", "1920")
            .replace("?6", "1080")
            .replace("?7", str(version))
            .replace("?8", f"'videos/{asset_id}/{version}/master.m3u8'")
            .replace("?9", "1700000000")
        )

    def _create(self, database, asset_id: str) -> None:
        """What `POST /api/video-assets` leaves behind: an uploading row."""

        database.execute(
            "INSERT INTO video_assets (id, title, original_filename, source_key, status,"
            " byte_size, created_at, updated_at)"
            " VALUES (?, '暫定標題', 'lesson.mp4', '', 'uploading', 1234, 1, 1)",
            (asset_id,),
        )

    def test_an_asset_the_tool_created_becomes_ready(self, database):
        self._create(database, "a" * 24)

        self._register(database, asset_id="a" * 24, title="第一課", version=1)

        row = database.execute(
            "SELECT status, title, active_encode_version, master_key FROM video_assets WHERE id = ?",
            ("a" * 24,),
        ).fetchone()
        assert row == ("ready", "第一課", 1, f"videos/{'a' * 24}/1/master.m3u8")

    def test_it_does_not_create_a_second_row(self, database):
        self._create(database, "a" * 24)

        self._register(database, asset_id="a" * 24, title="第一課", version=1)

        assert database.execute("SELECT COUNT(*) FROM video_assets").fetchone()[0] == 1

    def test_re_importing_the_same_version_is_idempotent(self, database):
        """Somebody re-syncing after a dropped object runs this twice."""

        self._create(database, "a" * 24)
        self._register(database, asset_id="a" * 24, title="第一課", version=1)

        self._register(database, asset_id="a" * 24, title="第一課", version=1)

        assert database.execute("SELECT COUNT(*) FROM video_assets").fetchone()[0] == 1

    def test_an_asset_with_no_row_at_all_is_still_inserted(self, database):
        """The other entrance: an encode imported without the tool creating it."""

        self._register(database, asset_id="b" * 24, title="舊課", version=1)

        row = database.execute(
            "SELECT status, active_encode_version FROM video_assets WHERE id = ?", ("b" * 24,)
        ).fetchone()
        assert row == ("ready", 1)

    def test_the_size_measured_at_upload_is_not_overwritten_with_zero(self, database):
        """`create` knows the source's size; `import` does not send one."""

        self._create(database, "a" * 24)

        self._register(database, asset_id="a" * 24, title="第一課", version=1)

        assert database.execute(
            "SELECT byte_size FROM video_assets WHERE id = ?", ("a" * 24,)
        ).fetchone()[0] == 1234

    def test_a_new_encode_version_moves_the_active_one(self, database):
        """S8 re-encodes into a new version and switches to it once verified."""

        self._create(database, "a" * 24)
        self._register(database, asset_id="a" * 24, title="第一課", version=1)

        self._register(database, asset_id="a" * 24, title="第一課", version=2)

        row = database.execute(
            "SELECT active_encode_version, master_key FROM video_assets WHERE id = ?", ("a" * 24,)
        ).fetchone()
        assert row == (2, f"videos/{'a' * 24}/2/master.m3u8")
