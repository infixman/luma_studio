"""What may be deleted, sorted by what deleting it costs.

Two lists, because the consequences are not comparable and a screen that mixes
them teaches somebody to click through both. An orphan is rubbish: nothing names
it and deleting it loses nothing anybody can describe. An original no course uses
is a video that can never be re-encoded — a ladder cannot be rebuilt from the
ladder — and that is a decision.

So `safe` may be cleared in one action; `needsJudgement` may not, and each of its
entries carries the sentence somebody has to read before agreeing to it.

A source a lesson still uses is in neither list. Not warned about: there is no
entrance. A warning is a thing somebody clicks past at four in the afternoon.
"""

from domain import storage_report, storage_scan, video, video_storage


# How long a replaced encode stays off the list. Going back to the previous
# version is the recovery for a re-encode that turned out wrong, and the hour
# somebody notices is the first one.
ROLLBACK_SECONDS = 7 * 24 * 60 * 60

UNUSED_SOURCE_CONSEQUENCE = "刪除後這支影片無法再重新轉檔"


async def candidates(env, *, now: int) -> dict:
    """Everything that could go, split by whether it is a decision.

    Built from the same lists the storage pages show rather than from its own
    queries: a cleanup screen disagreeing with the list beside it about what
    exists is worse than either being wrong on its own.
    """

    scan = await storage_scan.latest_scan(env)
    safe: list[dict] = []
    needs_judgement: list[dict] = []

    if scan is not None:
        # One entry per bucket, not one per key. A list of nine thousand objects
        # is not something anybody ticks through, and the decision is the same
        # for all of them.
        for bucket, byte_key, count_key in (
            ("source", "sourceBytes", "sourceObjects"),
            ("output", "outputBytes", "outputObjects"),
        ):
            if scan[count_key]:
                safe.append(
                    {
                        "kind": "orphan",
                        "bucket": bucket,
                        "keys": scan[count_key],
                        "bytes": scan[byte_key],
                    }
                )

    by_asset = await storage_report.versions_by_asset(env)
    for source in await storage_report.sources(env):
        if source["lessons"]:
            # In use. No entry of any kind, in either list.
            continue

        for version in by_asset.get(source["assetId"], []):
            if not version["isSuperseded"] or version["isActive"]:
                continue
            if version["verifiedAt"] > now - ROLLBACK_SECONDS:
                continue
            safe.append(
                {
                    "kind": "supersededVersion",
                    "assetId": source["assetId"],
                    "title": source["title"],
                    "encodeVersion": version["encodeVersion"],
                    "bytes": version["bytes"],
                }
            )

        # An upload that never finished has no original object to remove; what it
        # did send is the sweep's business, and the sweep reports it.
        if source["status"] != "uploading" and source["bytes"] > 0:
            needs_judgement.append(
                {
                    "kind": "unusedSource",
                    "assetId": source["assetId"],
                    "title": source["title"],
                    "bytes": source["bytes"],
                    "consequence": UNUSED_SOURCE_CONSEQUENCE,
                }
            )

    return {
        "safe": safe,
        "needsJudgement": needs_judgement,
        "scannedAt": None if scan is None else scan["scannedAt"],
    }


DELETE_VERSION_SQL = "DELETE FROM video_encode_versions WHERE asset_id = ?1 AND encode_version = ?2"

# One deletion is one request to R2, so a version with a few hundred objects is a
# few hundred of them. Bounded for the same reason the sweep's recording is: this
# has to finish inside one Worker invocation.
MAX_DELETES = 400


async def _keys_under(env, *, kind: str, prefix: str) -> tuple[list[str], bool]:
    """Every object under this prefix, and whether that is really all of them.

    Paged, because a listing answers at most a couple of hundred at a time and a
    ladder is more than that. The second value is what stops the caller removing
    the row that names objects it did not manage to delete: an object nothing
    records is exactly the orphan this whole feature exists to stop making.
    """

    keys: list[str] = []
    cursor = None
    while len(keys) < MAX_DELETES:
        listing = await video_storage.list_objects(env, kind=kind, prefix=prefix, cursor=cursor)
        keys.extend(item["key"] for item in listing["objects"])
        cursor = listing["cursor"]
        if not listing["truncated"] or not cursor:
            return keys, True
    return keys[:MAX_DELETES], False


async def _remove(env, *, kind: str, keys, dry_run: bool) -> list[str]:
    """Delete these objects, or say which ones would go.

    The same walk either way. A preview produced by different code is a preview
    of something else, and this is the one action here that cannot be undone.
    """

    bucket = video_storage.binding_for(env, kind)
    removed = []
    for key in keys[:MAX_DELETES]:
        if not dry_run:
            await bucket.delete(key)
        removed.append(key)
    return removed


async def delete_source(env, *, asset_id: str, dry_run: bool = False, now: int) -> dict:
    """Remove an original nothing uses.

    The references are read again here rather than taken from the list that
    offered this. A lesson can start using a source between a page loading and a
    button being pressed, and the page is not the authority — nor is it the thing
    that has to be right.
    """

    asset = await video.get_asset(env, asset_id)
    if asset is None:
        raise LookupError("Video not found")
    if asset["status"] == "uploading":
        # Mid-transfer. Its objects are being written right now, and the parts
        # already sent belong to a session that can still finish.
        raise ValueError("這支影片還在上傳中，不能刪除原始檔")

    lessons = await video.lessons_using(env, asset_id)
    if lessons:
        names = "、".join(lesson["title"] for lesson in lessons[:3])
        raise ValueError(f"這支影片正被單元「{names}」使用，不能刪除原始檔")

    keys, complete = await _keys_under(env, kind="source", prefix=video.source_prefix(asset_id, 1))
    return {
        "assetId": asset_id,
        "deleted": await _remove(env, kind="source", keys=keys, dry_run=dry_run),
        "complete": complete,
        "dryRun": dry_run,
    }


async def delete_version(
    env, *, asset_id: str, encode_version: int, dry_run: bool = False, now: int
) -> dict:
    """Remove a superseded encode and the row that named it.

    The live version is refused here as well as being absent from the list. The
    list is a suggestion; this is the rule.
    """

    asset = await video.get_asset(env, asset_id)
    if asset is None:
        raise LookupError("Video not found")
    if asset["encodeVersion"] == encode_version:
        raise ValueError("這是目前正在播放的版本，不能刪除")

    recorded = [
        version
        for version in await storage_report.versions(env, asset_id=asset_id)
        if version["encodeVersion"] == encode_version
    ]
    if recorded and recorded[0]["verifiedAt"] > now - ROLLBACK_SECONDS:
        # The same window the list applies. Without it here, knowing an id and a
        # number is enough to remove the version somebody would roll back to,
        # seconds after a re-encode replaced it.
        raise ValueError("這個版本才剛被取代，暫時保留以便退回")

    keys, complete = await _keys_under(
        env, kind="output", prefix=video.encode_prefix(asset_id, encode_version)
    )
    deleted = await _remove(env, kind="output", keys=keys, dry_run=dry_run)

    rows_removed = 0
    if not dry_run and complete:
        # Only once every object is gone. Removing the row while objects remain
        # leaves them unfindable — an orphan created by the cleanup itself.
        await env.DB.prepare(DELETE_VERSION_SQL).bind(asset_id, encode_version).run()
        rows_removed = 1

    return {
        "assetId": asset_id,
        "encodeVersion": encode_version,
        "deleted": deleted,
        "rowsRemoved": rows_removed,
        "complete": complete,
        "dryRun": dry_run,
    }


async def delete_orphans(env, *, bucket: str, dry_run: bool = False) -> dict:
    """Remove what the last finished sweep wrote down.

    Deliberately not "everything unaccounted for": this deletes a list somebody
    can look at first, produced at a moment that is recorded. A deployment that
    never swept removes nothing, which is the right answer to a button pressed
    before anybody has looked.
    """

    found = await storage_scan.orphans(env, bucket=bucket, limit=MAX_DELETES)
    keys = [entry["key"] for entry in found]
    return {
        "bucket": bucket,
        "deleted": await _remove(env, kind=bucket, keys=keys, dry_run=dry_run),
        "dryRun": dry_run,
    }
