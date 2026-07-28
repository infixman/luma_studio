"""Drafts, published versions, and restoring one."""

import asyncio
import json

import pytest

from conftest import ADMIN_ORIGIN, FakeDatabase, FakeRequest, make_env


@pytest.fixture
def pages():
    import pages as module

    return module


def text_block(body="哈囉", position=0):
    return {"id": f"b{position}", "type": "text", "config": json.dumps({"body": body}), "position": position}


def run(coroutine):
    return asyncio.run(coroutine)


class TestSnapshots:
    """What a version stores, and what it deliberately does not."""

    def test_it_keeps_the_type_and_config_in_order(self, pages):
        blocks = [
            {"id": "b1", "type": "text", "config": {"body": "一"}, "position": 0},
            {"id": "b2", "type": "text", "config": {"body": "二"}, "position": 1},
        ]
        stored = json.loads(pages.snapshot_of(blocks))
        assert [entry["type"] for entry in stored] == ["text", "text"]
        assert [entry["config"]["body"] for entry in stored] == ["一", "二"]

    def test_it_does_not_keep_block_ids(self, pages):
        """A restored version is new rows. Keeping the old ids would tie a
        restore to whether those rows still exist."""

        stored = json.loads(pages.snapshot_of([{"id": "b1", "type": "text", "config": {"body": "x"}, "position": 0}]))
        assert "id" not in stored[0]

    def test_it_does_not_keep_the_hydrated_data(self, pages):
        """`data` carries the prices and stock of the moment. A version
        records a layout, not what the shop happened to be selling."""

        blocks = [
            {
                "id": "b1",
                "type": "shop",
                "config": {"slugs": ["mug"]},
                "data": {"products": [{"slug": "mug", "price": 380}]},
                "position": 0,
            }
        ]
        assert "380" not in pages.snapshot_of(blocks)
        assert "data" not in json.loads(pages.snapshot_of(blocks))[0]

    def test_the_same_content_compares_equal_whatever_the_key_order(self, pages):
        """That string comparison is the whole of "has this been published
        yet", so dict ordering must not be able to answer it wrongly."""

        one = pages.snapshot_of([{"id": "b1", "type": "text", "config": {"body": "x"}, "position": 0}])
        two = pages.snapshot_of([{"position": 0, "config": {"body": "x"}, "type": "text", "id": "b9"}])
        assert one == two


class TestReadingASnapshotBack:
    def test_it_comes_back_as_blocks(self, pages):
        payload = pages.snapshot_of([{"id": "b1", "type": "text", "config": {"body": "哈囉"}, "position": 0}])
        blocks = pages.blocks_of_snapshot(payload)
        assert blocks[0]["type"] == "text" and blocks[0]["config"]["body"] == "哈囉"
        assert blocks[0]["position"] == 0

    def test_a_block_that_no_longer_validates_is_skipped_not_fatal(self, pages):
        """A stored version is old by definition. One stale block must not
        take a published page down."""

        payload = json.dumps(
            [{"type": "nonsense", "config": {}}, {"type": "text", "config": {"body": "還在"}}]
        )
        blocks = pages.blocks_of_snapshot(payload)
        assert [block["config"]["body"] for block in blocks] == ["還在"]

    def test_a_payload_that_is_not_json_is_an_empty_page_not_a_crash(self, pages):
        assert pages.blocks_of_snapshot("{oh no") == []
        assert pages.blocks_of_snapshot('{"not": "a list"}') == []


class TestPublishing:
    def test_the_old_current_is_demoted_before_the_new_one_is_written(self, pages):
        """The other order leaves a moment with no current version, which is
        a page that 404s."""

        database = FakeDatabase({"FROM page_blocks": [text_block()]})
        run(pages.publish(make_env(database), "p1", "owner@luma"))
        writes = [statement for statement, _ in database.writes]
        demote = next(i for i, w in enumerate(writes) if "SET is_current = 0" in w)
        insert = next(i for i, w in enumerate(writes) if "INSERT INTO page_versions" in w)
        assert demote < insert

    def test_publishing_also_makes_the_page_public(self, pages):
        """Pressing 發布 on a draft means both things. A second button for the
        second half is a button somebody has to discover."""

        database = FakeDatabase({"FROM page_blocks": [text_block()]})
        run(pages.publish(make_env(database), "p1", "owner@luma"))
        assert any("SET status = 'published'" in statement for statement, _ in database.writes)

    def test_who_published_it_is_recorded(self, pages):
        database = FakeDatabase({"FROM page_blocks": [text_block()]})
        answer = run(pages.publish(make_env(database), "p1", "owner@luma"))
        assert answer["publishedBy"] == "owner@luma"

    def test_the_history_is_trimmed_and_the_current_one_is_never_trimmed(self, pages):
        """Losing the current version leaves the page with nothing to serve."""

        database = FakeDatabase({"FROM page_blocks": [text_block()]})
        run(pages.publish(make_env(database), "p1", "owner@luma"))
        trim = [b for s, b in database.writes if "DELETE FROM page_versions" in s]
        assert trim, "nothing trimmed the history"
        statement = [s for s, _ in database.writes if "DELETE FROM page_versions" in s][0]
        assert "is_current = 0" in statement
        assert trim[0][1] == pages.MAX_VERSIONS


class TestUnpublishing:
    def test_the_versions_survive(self, pages):
        """Taking a page down is not deciding it never existed."""

        database = FakeDatabase()
        run(pages.unpublish(make_env(database), "p1"))
        assert not any("DELETE FROM page_versions" in statement for statement in database.statements)
        assert any("SET status = 'draft'" in statement for statement in database.statements)


class TestRestoring:
    def test_it_replaces_the_draft_blocks(self, pages):
        payload = pages.snapshot_of([{"id": "old", "type": "text", "config": {"body": "回來了"}, "position": 0}])
        database = FakeDatabase({"SELECT payload FROM page_versions": [{"payload": payload}]})
        assert run(pages.restore(make_env(database), "p1", "v1")) is True
        writes = [statement for statement, _ in database.writes]
        assert any("DELETE FROM page_blocks" in statement for statement in writes)
        assert any("INSERT INTO page_blocks" in statement for statement in writes)

    def test_it_does_not_put_the_page_live(self, pages):
        """Restoring goes into the draft. You will want to look first, and a
        second route to going live is a second place for it to go wrong."""

        payload = pages.snapshot_of([{"id": "old", "type": "text", "config": {"body": "x"}, "position": 0}])
        database = FakeDatabase({"SELECT payload FROM page_versions": [{"payload": payload}]})
        run(pages.restore(make_env(database), "p1", "v1"))
        assert not any("INSERT INTO page_versions" in statement for statement in database.statements)
        assert not any("SET status = 'published'" in statement for statement in database.statements)

    def test_a_version_that_is_not_this_page_s_is_refused(self, pages):
        """The query is scoped to the page, so an id from another page finds
        nothing rather than being restored onto this one."""

        database = FakeDatabase()
        assert run(pages.restore(make_env(database), "p1", "v-from-elsewhere")) is False
        query = [read for read in database.reads if "SELECT payload FROM page_versions" in read[0]][0]
        assert "page_id = ?2" in query[0]

    def test_the_restored_blocks_get_fresh_ids(self, pages):
        payload = pages.snapshot_of([{"id": "old", "type": "text", "config": {"body": "x"}, "position": 0}])
        database = FakeDatabase({"SELECT payload FROM page_versions": [{"payload": payload}]})
        run(pages.restore(make_env(database), "p1", "v1"))
        inserted = [b for s, b in database.writes if "INSERT INTO page_blocks" in s][0]
        assert inserted[0] not in {"old", "v0"}


class TestTheThreeStates:
    def test_never_published_is_a_draft(self, pages):
        database = FakeDatabase({"FROM page_blocks": [text_block()]})
        assert run(pages.publish_state(make_env(database), "p1")) == "draft"

    def test_a_draft_matching_its_version_is_published(self, pages):
        blocks = [{"id": "b0", "type": "text", "config": {"body": "哈囉"}, "position": 0}]
        database = FakeDatabase(
            {
                "FROM page_versions": [{"payload": pages.snapshot_of(blocks), "is_current": 1}],
                "FROM page_blocks": [text_block()],
            }
        )
        assert run(pages.publish_state(make_env(database), "p1")) == "published"

    def test_a_payload_written_by_the_migration_is_not_read_as_modified(self, pages):
        """Migration 0021 built its payloads with SQLite's `json_object`,
        which writes the keys in the order given and no spaces. `json.dumps`
        here sorts and spaces them. Comparing the stored string directly told
        every page that already existed it had unpublished changes, on the
        first request after deploying, forever."""

        # Exactly what `json_group_array(json_object('type', ..., 'config',
        # json(...)))` produces.
        migrated = '[{"type":"text","config":{"body":"哈囉"}}]'
        assert migrated != pages.snapshot_of([{"type": "text", "config": {"body": "哈囉"}, "position": 0}])

        database = FakeDatabase(
            {"FROM page_versions": [{"payload": migrated, "is_current": 1}], "FROM page_blocks": [text_block()]}
        )
        assert run(pages.publish_state(make_env(database), "p1")) == "published"

    def test_the_blocks_can_be_handed_in_rather_than_read_twice(self, pages):
        """The editor's detail response has already read them."""

        published = pages.snapshot_of([{"type": "text", "config": {"body": "哈囉"}, "position": 0}])
        database = FakeDatabase({"FROM page_versions": [{"payload": published, "is_current": 1}]})
        blocks = [{"id": "b0", "type": "text", "config": {"body": "哈囉"}, "position": 0}]
        assert run(pages.publish_state(make_env(database), "p1", blocks)) == "published"
        assert not any("FROM page_blocks" in statement for statement in database.statements)

    def test_an_edited_draft_is_modified(self, pages):
        """The state that was invisible before any of this existed: edited
        since it was published, with nothing on screen saying so."""

        published = pages.snapshot_of([{"id": "b0", "type": "text", "config": {"body": "舊的"}, "position": 0}])
        database = FakeDatabase(
            {
                "FROM page_versions": [{"payload": published, "is_current": 1}],
                "FROM page_blocks": [text_block("改過了")],
            }
        )
        assert run(pages.publish_state(make_env(database), "p1")) == "modified"
