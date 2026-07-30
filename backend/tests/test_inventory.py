"""Stock as its own thing, separate from what is being sold.

A variant used to be both the price customers see and the count in the
stockroom. Once a kit can be sold on its own *and* included in two course
bundles, those cannot be the same row: three offers share one pile of stock.
These tests are mostly about the rules that stop that pile going wrong.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def inventory():
    from domain import inventory as module

    return module


class TestValidation:
    def test_a_title_is_required(self, inventory):
        with pytest.raises(ValueError):
            inventory.validate_title("   ")

    def test_a_title_is_trimmed(self, inventory):
        assert inventory.validate_title("  水彩材料包  ") == "水彩材料包"

    def test_a_sku_is_optional_and_trimmed(self, inventory):
        assert inventory.validate_sku("  KIT-1 ") == "KIT-1"
        assert inventory.validate_sku("") == ""
        assert inventory.validate_sku(None) == ""

    def test_stock_cannot_be_negative(self, inventory):
        assert inventory.validate_stock(0) == 0
        with pytest.raises(ValueError):
            inventory.validate_stock(-1)

    @pytest.mark.parametrize("value", [1.0, "1", True, None])
    def test_stock_that_is_not_a_whole_number_is_refused_rather_than_coerced(self, inventory, value):
        with pytest.raises(ValueError):
            inventory.validate_stock(value)


class TestRowMapping:
    def test_a_row_becomes_the_shape_the_editor_reads(self, inventory):
        mapped = inventory.item_row(
            {
                "id": "kit-1",
                "sku": "KIT-1",
                "title": "水彩材料包",
                "stock": 12,
                "enabled": 1,
                "archived_at": None,
                "created_at": 5,
                "updated_at": 6,
            }
        )

        assert mapped == {
            "id": "kit-1",
            "sku": "KIT-1",
            "title": "水彩材料包",
            "stock": 12,
            "enabled": True,
            "archived": False,
            "createdAt": 5,
            "updatedAt": 6,
        }

    def test_an_archived_item_says_so_rather_than_exposing_the_timestamp(self, inventory):
        mapped = inventory.item_row(
            {
                "id": "kit-1",
                "sku": "",
                "title": "舊材料包",
                "stock": 0,
                "enabled": 0,
                "archived_at": 99,
                "created_at": 5,
                "updated_at": 6,
            }
        )

        assert mapped["archived"] is True
        assert "archived_at" not in mapped


class TestUniqueSku:
    def test_a_blank_sku_never_counts_as_taken(self, inventory):
        """Two items nobody has coded yet are not a conflict."""

        database = FakeDatabase({"SELECT id FROM inventory_items": [{"id": "other"}]})

        assert asyncio.run(inventory.sku_taken(make_env(database), "")) is False
        assert database.reads == []

    def test_an_existing_sku_is_reported_as_taken(self, inventory):
        database = FakeDatabase({"SELECT id FROM inventory_items": [{"id": "other"}]})

        assert asyncio.run(inventory.sku_taken(make_env(database), "KIT-1")) is True

    def test_the_item_being_edited_does_not_conflict_with_itself(self, inventory):
        database = FakeDatabase()

        asyncio.run(inventory.sku_taken(make_env(database), "KIT-1", excluding="kit-1"))

        query, bindings = database.reads[0]
        assert "id != ?2" in query
        assert bindings == ("KIT-1", "kit-1")


class TestAdjustment:
    """An admin correcting a count is not the same event as an order taking one."""

    def test_the_count_before_and_after_comes_back_for_the_audit_line(self, inventory):
        """"Set stock to 12" is unauditable on its own. What was it before?"""

        database = FakeDatabase({"SELECT * FROM inventory_items": [{
            "id": "kit-1", "sku": "", "title": "材料包", "stock": 5,
            "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
        }]})

        change = asyncio.run(inventory.adjust_stock(make_env(database), "kit-1", 12))

        assert change == {"before": 5, "after": 12}

    def test_adjusting_something_that_is_not_there_reports_it(self, inventory):
        assert asyncio.run(inventory.adjust_stock(make_env(FakeDatabase()), "ghost", 12)) is None


class TestStockMovement:
    def test_stock_is_taken_only_when_there_is_enough_of_it(self, inventory):
        """The condition is in the statement, not in a read beforehand.

        D1 has no interactive transaction, so checking and then deducting is
        two statements another request can slip between. Overselling is the
        one failure this whole table exists to prevent.
        """

        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 1})

        assert asyncio.run(inventory.take_stock(make_env(database), "kit-1", 2)) is True

        statement, bindings = database.writes[0]
        assert "stock >= ?2" in statement
        assert "enabled = 1" in statement
        # A movement changes the row, so it carries a timestamp like any
        # other write; the test only pins the two values it is about.
        assert bindings[:2] == ("kit-1", 2)

    def test_taking_more_than_is_there_changes_nothing_and_says_so(self, inventory):
        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 0})

        assert asyncio.run(inventory.take_stock(make_env(database), "kit-1", 99)) is False

    def test_giving_stock_back_is_unconditional(self, inventory):
        """A release must not depend on the item still being for sale.

        An order that reserved stock has to be able to return it even after
        the item was disabled, or the count stays wrong for good.
        """

        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock +": 1})

        asyncio.run(inventory.give_back_stock(make_env(database), "kit-1", 2))

        statement, _ = database.writes[0]
        assert "enabled" not in statement


class TestAdjustmentAudit:
    """An adjustment is somebody's claim about the physical world.

    Without a record of who said what and when, a count that turns out wrong
    has no story attached to it, and "stock set to 12" cannot be argued with
    because it says nothing.
    """

    def _database(self, stock=5):
        return FakeDatabase({"SELECT * FROM inventory_items": [{
            "id": "kit-1", "sku": "", "title": "材料包", "stock": stock,
            "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
        }]})

    def test_an_adjustment_records_who_before_and_after(self, inventory):
        database = self._database(stock=5)

        asyncio.run(
            inventory.adjust_stock(make_env(database), "kit-1", 12, actor="owner@example.com", reason="盤點")
        )

        statement, bindings = next(w for w in database.writes if "INSERT INTO inventory_audit_log" in w[0])
        assert "owner@example.com" in bindings
        assert 5 in bindings and 12 in bindings
        assert "盤點" in bindings

    def test_an_adjustment_that_changes_nothing_is_still_recorded(self, inventory):
        """"I checked and it was right" is worth knowing, and is exactly what
        somebody will want to see the day it turns out to be wrong."""

        database = self._database(stock=12)

        asyncio.run(
            inventory.adjust_stock(make_env(database), "kit-1", 12, actor="owner@example.com", reason="盤點")
        )

        assert any("INSERT INTO inventory_audit_log" in write[0] for write in database.writes)

    def test_an_order_taking_stock_is_not_an_adjustment(self, inventory):
        """The system doing its job is not a claim anybody needs to defend, and
        an audit line per sale would bury the ones that matter."""

        database = FakeDatabase(changes={"UPDATE inventory_items SET stock = stock -": 1})

        asyncio.run(inventory.take_stock(make_env(database), "kit-1", 2))

        assert not any("inventory_audit_log" in write[0] for write in database.writes)
