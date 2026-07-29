"""Published page snapshots and their history.

The draft and block validation live in :mod:`pages`.  They are obtained only
when a version operation runs, rather than at module import time, so the page
module can re-export this public API without a circular import.
"""

import json

from common import d1_changed, d1_rows, urlsafe_token, utc_timestamp


# Twenty is a storage ceiling, not a promise that every historical version is
# kept forever.  Each version stores the whole page as JSON.
MAX_VERSIONS = 20


def _pages_module():
    """Return page primitives after both modules have finished importing."""

    from domain import pages

    return pages


def snapshot_of(blocks: list[dict]) -> str:
    """Serialize a draft's block type and config, excluding transient data."""

    return json.dumps(
        [{"type": block["type"], "config": block["config"]} for block in blocks],
        ensure_ascii=False,
        # Equivalent configs must compare equal even if their dictionaries were
        # assembled in different orders.
        sort_keys=True,
    )


def blocks_of_snapshot(payload: str) -> list[dict]:
    """Read a stored snapshot using the current page-block validation rules."""

    try:
        entries = json.loads(payload)
    except (TypeError, ValueError):
        return []
    if not isinstance(entries, list):
        return []

    pages = _pages_module()
    blocks = []
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        try:
            block_type, config = pages.validate_block(entry.get("type"), entry.get("config"))
        except (pages.PageError, ValueError):
            # A version can outlive a block schema.  One stale block should
            # not make the entire historical page unavailable.
            continue
        blocks.append({"id": f"v{position}", "type": block_type, "config": config, "position": position})
    return blocks


async def current_version(env, page_id: str) -> dict | None:
    """What the public is being served for this page, if anything."""

    rows = await d1_rows(
        env.DB.prepare("SELECT * FROM page_versions WHERE page_id = ?1 AND is_current = 1").bind(page_id)
    )
    return dict(rows[0]) if rows else None


async def list_versions(env, page_id: str) -> list[dict]:
    """Return the published history, newest first, without full payloads."""

    rows = await d1_rows(
        env.DB.prepare(
            """SELECT id, published_at, published_by, is_current
                 FROM page_versions WHERE page_id = ?1 ORDER BY published_at DESC, id DESC"""
        ).bind(page_id)
    )
    return [
        {
            "id": row["id"],
            "publishedAt": int(row["published_at"]),
            "publishedBy": row["published_by"],
            "isCurrent": bool(row["is_current"]),
        }
        for row in rows
    ]


async def version_payload(env, page_id: str, version_id: str) -> str | None:
    """Return one version's payload, scoped to its owning page."""

    rows = await d1_rows(
        env.DB.prepare("SELECT payload FROM page_versions WHERE id = ?1 AND page_id = ?2").bind(version_id, page_id)
    )
    return rows[0]["payload"] if rows else None


async def publish(env, page_id: str, actor: str) -> dict:
    """Make the draft the version customers see."""

    pages = _pages_module()
    payload = snapshot_of(await pages.list_blocks(env, page_id))
    now = utc_timestamp()
    version_id = urlsafe_token(18)

    # Demote first: the insert then leaves exactly one public version.
    await env.DB.prepare("UPDATE page_versions SET is_current = 0 WHERE page_id = ?1 AND is_current = 1").bind(
        page_id
    ).run()
    await env.DB.prepare(
        """INSERT INTO page_versions (id, page_id, payload, published_at, published_by, is_current)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)"""
    ).bind(version_id, page_id, payload, now, actor).run()
    await env.DB.prepare("UPDATE pages SET status = 'published', updated_at = ?2 WHERE id = ?1").bind(
        page_id, now
    ).run()
    await _trim_versions(env, page_id)
    return {"id": version_id, "publishedAt": now, "publishedBy": actor, "isCurrent": True}


async def _trim_versions(env, page_id: str) -> None:
    """Drop non-current history past ``MAX_VERSIONS``."""

    await env.DB.prepare(
        """DELETE FROM page_versions
             WHERE page_id = ?1 AND is_current = 0
               AND id NOT IN (
                 SELECT id FROM page_versions WHERE page_id = ?1
                  ORDER BY published_at DESC, id DESC LIMIT ?2)"""
    ).bind(page_id, MAX_VERSIONS).run()


async def unpublish(env, page_id: str) -> bool:
    """Take a page down while retaining its version history."""

    await env.DB.prepare("UPDATE page_versions SET is_current = 0 WHERE page_id = ?1").bind(page_id).run()
    result = await (
        env.DB.prepare("UPDATE pages SET status = 'draft', updated_at = ?2 WHERE id = ?1")
        .bind(page_id, utc_timestamp())
        .run()
    )
    return d1_changed(result)


async def restore(env, page_id: str, version_id: str) -> bool:
    """Restore a version into the draft; publishing remains explicit."""

    payload = await version_payload(env, page_id, version_id)
    if payload is None:
        return False

    pages = _pages_module()
    blocks = blocks_of_snapshot(payload)
    await env.DB.prepare("DELETE FROM page_blocks WHERE page_id = ?1").bind(page_id).run()
    for position, block in enumerate(blocks):
        await env.DB.prepare(
            "INSERT INTO page_blocks (id, page_id, type, config, position) VALUES (?1, ?2, ?3, ?4, ?5)"
        ).bind(
            urlsafe_token(18), page_id, block["type"], json.dumps(block["config"], ensure_ascii=False), position
        ).run()
    await pages.touch_page(env, page_id)
    return True


async def publish_state(env, page_id: str, blocks: list[dict] | None = None) -> str:
    """Return whether a draft has never been, is, or differs from published."""

    current = await current_version(env, page_id)
    if current is None:
        return "draft"
    pages = _pages_module()
    stored = snapshot_of(blocks_of_snapshot(current["payload"]))
    draft = snapshot_of(await pages.list_blocks(env, page_id) if blocks is None else blocks)
    return "published" if stored == draft else "modified"
