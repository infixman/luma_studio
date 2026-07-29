"""What an Offer actually delivers, and the one place that works it out.

An Offer holds the price. What the customer receives is a flat list of
components, each naming a Course or an InventoryItem. Whether something needs
posting, whether it grants access, whether it is a bundle — all of that is
read off that list. None of it is stored, because a stored copy is a second
answer that can disagree with the one fulfilment uses.

`resolve_offer` is the only place that expansion happens. The cart quoting one
rule and checkout quoting another is the failure this design exists to make
impossible.
"""

import asyncio

import pytest

from conftest import FakeDatabase, make_env


@pytest.fixture
def offers():
    from domain import offers as module

    return module


def entry(type_: str, component_id: str, **extra) -> dict:
    return {"type": type_, "componentId": component_id, **extra}


class TestComponentValidation:
    def test_a_course_component_is_always_one(self, offers):
        """Two of a course is not a thing; access is access."""

        with pytest.raises(ValueError):
            offers.validate_components([entry("course", "c1", quantity=2)])

    def test_a_course_may_carry_a_viewing_window_or_none(self, offers):
        assert offers.validate_components([entry("course", "c1", accessDays=30)])[0]["accessDays"] == 30
        assert offers.validate_components([entry("course", "c1")])[0]["accessDays"] is None

    @pytest.mark.parametrize("value", [0, -1, 1.5, "30", True])
    def test_a_viewing_window_that_is_not_a_positive_whole_number_is_refused(self, offers, value):
        with pytest.raises(ValueError):
            offers.validate_components([entry("course", "c1", accessDays=value)])

    def test_an_inventory_component_cannot_carry_a_viewing_window(self, offers):
        """A material kit does not expire; accepting the field invites the
        belief that it does something."""

        with pytest.raises(ValueError):
            offers.validate_components([entry("inventory", "k1", accessDays=30)])

    def test_an_inventory_component_may_be_wanted_more_than_once(self, offers):
        assert offers.validate_components([entry("inventory", "k1", quantity=3)])[0]["quantity"] == 3

    @pytest.mark.parametrize("value", [0, -1, 1.5, "2"])
    def test_an_inventory_quantity_below_one_or_not_whole_is_refused(self, offers, value):
        with pytest.raises(ValueError):
            offers.validate_components([entry("inventory", "k1", quantity=value)])

    @pytest.mark.parametrize("type_", ["offer", "bundle", "product", ""])
    def test_only_courses_and_inventory_items_can_be_delivered(self, offers, type_):
        """Pointing a component at another Offer is what makes bundles
        recursive. There is no such type, so there is no such cycle."""

        with pytest.raises(ValueError):
            offers.validate_components([entry(type_, "x1")])

    def test_the_same_target_twice_is_a_quantity_not_two_components(self, offers):
        with pytest.raises(ValueError):
            offers.validate_components([entry("inventory", "k1"), entry("inventory", "k1")])

    def test_the_same_id_under_different_types_is_not_a_duplicate(self, offers):
        assert len(offers.validate_components([entry("course", "x1"), entry("inventory", "x1")])) == 2

    def test_position_comes_from_the_order_sent_not_from_the_client(self, offers):
        validated = offers.validate_components(
            [entry("course", "c1", position=99), entry("inventory", "k1", position=99)]
        )

        assert [item["position"] for item in validated] == [0, 1]

    def test_an_offer_may_deliver_nothing_yet(self, offers):
        """A newly created offer has no components until someone adds them;
        refusing the empty set would make it impossible to clear one."""

        assert offers.validate_components([]) == []


class TestTargetValidation:
    """Shape is not enough: the thing being pointed at has to be real.

    `component_id` names a row in one of two tables, which no foreign key can
    express, so this check is the only thing standing between a saved offer
    and a component that delivers nothing.
    """

    def _database(self, *, courses=None, items=None):
        return FakeDatabase(
            {
                "FROM courses": courses if courses is not None else [],
                "FROM inventory_items": items if items is not None else [],
            }
        )

    def test_a_component_pointing_at_nothing_is_refused(self, offers):
        database = self._database()

        with pytest.raises(ValueError):
            asyncio.run(offers.validate_targets(make_env(database), [entry("inventory", "ghost", quantity=1)]))

    def test_an_archived_inventory_item_cannot_be_added(self, offers):
        database = self._database(items=[{"id": "k1", "enabled": 1, "archived_at": 99, "title": "舊材料"}])

        with pytest.raises(ValueError):
            asyncio.run(offers.validate_targets(make_env(database), [entry("inventory", "k1", quantity=1)]))

    def test_an_archived_course_cannot_be_added(self, offers):
        database = self._database(courses=[{"id": "c1", "status": "archived", "title": "舊課"}])

        with pytest.raises(ValueError):
            asyncio.run(offers.validate_targets(make_env(database), [entry("course", "c1", quantity=1)]))

    def test_a_draft_course_may_be_added_while_the_product_is_being_built(self, offers):
        """The admin writes the product and the course in whichever order
        suits them. What that must not do is let the offer go on sale."""

        database = self._database(courses=[{"id": "c1", "status": "draft", "title": "草稿課"}])

        asyncio.run(offers.validate_targets(make_env(database), [entry("course", "c1", quantity=1)]))

    def test_an_empty_set_asks_the_database_nothing(self, offers):
        database = self._database()

        asyncio.run(offers.validate_targets(make_env(database), []))

        assert database.reads == []


class TestSaleBlockers:
    """Why an Offer may not be enabled, in words the editor can show."""

    def _resolved(self, components: list[dict], **overrides) -> dict:
        return {
            "offerId": "off-1",
            "components": components,
            "componentUnavailable": False,
            **overrides,
        }

    def test_a_draft_course_stops_the_offer_going_on_sale(self, offers):
        resolved = self._resolved([{"type": "course", "targetTitle": "草稿課", "courseStatus": "draft"}])

        problems = offers.sale_blockers(resolved)

        assert [problem["reason"] for problem in problems] == ["course_not_published"]
        assert "草稿課" in problems[0]["message"]

    def test_a_published_course_stops_nothing(self, offers):
        resolved = self._resolved([{"type": "course", "targetTitle": "水彩", "courseStatus": "published"}])

        assert offers.sale_blockers(resolved) == []

    def test_a_target_that_vanished_is_reported_rather_than_silently_dropped(self, offers):
        resolved = self._resolved([], componentUnavailable=True)

        assert [problem["reason"] for problem in offers.sale_blockers(resolved)] == ["component_unavailable"]

    def test_an_offer_that_delivers_nothing_cannot_be_sold(self, offers):
        """Taking money for an empty set is the one case worth naming
        separately: nothing is wrong with any component, there are none."""

        assert [problem["reason"] for problem in offers.sale_blockers(self._resolved([]))] == ["no_components"]


class TestSimpleOfferStock:
    """The old product editor edits one number and means one thing.

    A product sold without options has exactly one InventoryItem behind it, so
    "stock: 12" on that page is unambiguous. As soon as the item is shared
    with another offer, or the offer carries more than one, the same number
    means something the page never asked about — so it is refused rather than
    guessed at.
    """

    def _database(self, components: list[dict], *, referenced_by: list[str] | None = None):
        return FakeDatabase(
            {
                "SELECT * FROM offer_components": components,
                "SELECT offer_id FROM offer_components": [
                    {"offer_id": offer_id} for offer_id in (referenced_by or ["off-1"])
                ],
                "SELECT * FROM inventory_items": [{
                    "id": "kit-1", "sku": "KIT-1", "title": "材料包", "stock": 5,
                    "enabled": 1, "archived_at": None, "created_at": 0, "updated_at": 0,
                }],
            }
        )

    def _component(self, component_id: str, type_: str = "inventory"):
        return {
            "id": f"oc-{component_id}",
            "offer_id": "off-1",
            "component_type": type_,
            "component_id": component_id,
            "quantity": 1,
            "access_days": None,
            "position": 0,
        }

    def test_a_new_offer_is_given_its_own_item_and_component(self, offers):
        """Otherwise an offer created after the migration has no stock at all."""

        database = FakeDatabase()

        asyncio.run(
            offers.provision_simple_inventory(
                make_env(database), "off-9", title="畫筆", sku="BRUSH", stock=20, enabled=True
            )
        )

        item_insert, item_bindings = next(w for w in database.writes if "INSERT INTO inventory_items" in w[0])
        component_insert, _ = next(w for w in database.writes if "INSERT INTO offer_components" in w[0])
        # Same id as the offer, matching what the backfill did, so there is
        # never a mapping table to keep in step.
        assert item_bindings[0] == "off-9"
        assert "inventory" in component_insert

    def test_editing_stock_on_a_simple_offer_writes_to_the_item(self, offers):
        database = self._database([self._component("kit-1")])

        assert asyncio.run(offers.set_simple_offer_stock(make_env(database), "off-1", 12)) == {
            "before": 5,
            "after": 12,
        }

        assert any("UPDATE inventory_items SET stock = ?2" in statement for statement, _ in database.writes)

    def test_the_old_column_is_mirrored_so_the_order_path_stays_correct(self, offers):
        """Orders still deduct from product_variants until phase 3. Leaving
        that column behind would let the shop sell stock that is not there."""

        database = self._database([self._component("kit-1")])

        asyncio.run(offers.set_simple_offer_stock(make_env(database), "off-1", 12))

        mirror = next(w for w in database.writes if "UPDATE product_variants SET stock" in w[0])
        assert mirror[1] == ("off-1", 12)

    def test_stock_shared_with_another_offer_is_not_editable_from_the_product_page(self, offers):
        database = self._database([self._component("kit-1")], referenced_by=["off-1", "off-2"])

        with pytest.raises(ValueError):
            asyncio.run(offers.set_simple_offer_stock(make_env(database), "off-1", 12))

    def test_an_offer_carrying_more_than_one_item_is_not_editable_that_way(self, offers):
        database = self._database([self._component("kit-1"), self._component("kit-2")])

        with pytest.raises(ValueError):
            asyncio.run(offers.set_simple_offer_stock(make_env(database), "off-1", 12))

    def test_an_offer_that_only_grants_a_course_has_no_stock_to_set(self, offers):
        database = self._database([self._component("course-1", type_="course")])

        with pytest.raises(ValueError):
            asyncio.run(offers.set_simple_offer_stock(make_env(database), "off-1", 12))


class TestReferences:
    """What names a target, so it is archived rather than deleted."""

    def test_every_offer_using_a_kit_is_listed(self, offers):
        database = FakeDatabase(
            {"SELECT offer_id FROM offer_components": [{"offer_id": "off-1"}, {"offer_id": "off-2"}]}
        )

        assert asyncio.run(offers.references_of(make_env(database), "inventory", "kit-1")) == ["off-1", "off-2"]

    def test_the_lookup_is_narrowed_by_type_as_well_as_id(self, offers):
        """Ids are opaque, and the backfill deliberately reused offer ids for
        inventory items. Matching on the id alone would cross the two."""

        database = FakeDatabase()

        asyncio.run(offers.references_of(make_env(database), "course", "c1"))

        query, bindings = database.reads[0]
        assert "component_type = ?1" in query
        assert bindings == ("course", "c1")

    def test_something_nothing_points_at_is_free_to_remove(self, offers):
        assert asyncio.run(offers.references_of(make_env(FakeDatabase()), "inventory", "kit-9")) == []


class TestDerivedCapabilities:
    def test_an_offer_with_any_physical_component_has_to_be_posted(self, offers):
        assert offers.requires_shipping([{"type": "course"}, {"type": "inventory"}]) is True

    def test_an_offer_of_courses_alone_does_not(self, offers):
        assert offers.requires_shipping([{"type": "course"}, {"type": "course"}]) is False

    def test_containing_a_course_is_read_off_the_components(self, offers):
        assert offers.contains_course([{"type": "inventory"}]) is False
        assert offers.contains_course([{"type": "course"}]) is True

    def test_digital_only_means_a_course_and_nothing_to_post(self, offers):
        assert offers.digital_only([{"type": "course"}]) is True
        assert offers.digital_only([{"type": "course"}, {"type": "inventory"}]) is False
        # Nothing at all is not digital: there is nothing to grant either.
        assert offers.digital_only([]) is False

    def test_a_bundle_is_simply_more_than_one_component(self, offers):
        assert offers.is_bundle([{"type": "course"}]) is False
        assert offers.is_bundle([{"type": "course"}, {"type": "inventory"}]) is True


class TestResolveOffer:
    """One offer, expanded once, for both the cart and the order."""

    def _database(self, components: list[dict], *, price: int = 3980, enabled: int = 1, status: str = "active"):
        return FakeDatabase(
            {
                "FROM product_variants v JOIN products p": [
                    {
                        "id": "off-1",
                        "product_id": "prod-1",
                        "title": "",
                        "price": price,
                        "enabled": enabled,
                        "product_status": status,
                        "product_title": "水彩完整套組",
                    }
                ],
                "FROM offer_components": components,
                "FROM inventory_items": [
                    {"id": "kit-1", "title": "水彩材料包", "sku": "KIT-1", "stock": 12, "enabled": 1, "archived_at": None}
                ],
                "FROM courses": [{"id": "course-1", "title": "水彩花卉入門", "status": "published"}],
            }
        )

    def _component(self, type_: str, component_id: str, quantity: int = 1, access_days=None, position: int = 0):
        return {
            "id": f"oc-{component_id}",
            "offer_id": "off-1",
            "component_type": type_,
            "component_id": component_id,
            "quantity": quantity,
            "access_days": access_days,
            "position": position,
        }

    def test_a_mixed_offer_reports_both_capabilities(self, offers):
        database = self._database(
            [self._component("course", "course-1", access_days=30), self._component("inventory", "kit-1", position=1)]
        )

        resolved = asyncio.run(offers.resolve_offer(make_env(database), "off-1", 1))

        assert resolved["containsCourse"] is True
        assert resolved["requiresShipping"] is True
        assert resolved["digitalOnly"] is False
        assert resolved["price"] == 3980

    def test_a_course_only_offer_needs_no_delivery(self, offers):
        database = self._database([self._component("course", "course-1")])

        resolved = asyncio.run(offers.resolve_offer(make_env(database), "off-1", 1))

        assert resolved["requiresShipping"] is False
        assert resolved["digitalOnly"] is True

    def test_how_much_stock_a_line_needs_is_the_component_times_the_quantity(self, offers):
        """Two kits per offer, three offers in the cart, six kits reserved."""

        database = self._database([self._component("inventory", "kit-1", quantity=2)])

        resolved = asyncio.run(offers.resolve_offer(make_env(database), "off-1", 3))

        assert resolved["components"][0]["requiredQuantity"] == 6
        assert resolved["purchaseQuantity"] == 3

    def test_a_course_component_is_granted_once_however_many_are_bought(self, offers):
        database = self._database([self._component("course", "course-1")])

        resolved = asyncio.run(offers.resolve_offer(make_env(database), "off-1", 3))

        assert "requiredQuantity" not in resolved["components"][0]

    def test_the_snapshot_carries_the_target_name_and_sku(self, offers):
        """The order writes these down; the cart shows them. Reading them
        later off the current target would rewrite history."""

        database = self._database([self._component("inventory", "kit-1")])

        component = asyncio.run(offers.resolve_offer(make_env(database), "off-1", 1))["components"][0]

        assert component["targetTitle"] == "水彩材料包"
        assert component["sku"] == "KIT-1"

    def test_an_unknown_offer_resolves_to_nothing(self, offers):
        assert asyncio.run(offers.resolve_offer(make_env(FakeDatabase()), "nope", 1)) is None
