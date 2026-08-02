"""What may be deleted, sorted by what deleting it costs.

Two lists, because the consequences are not comparable and a screen that mixes
them teaches somebody to click through both. An orphan is rubbish: nothing names
it and deleting it loses nothing anybody can describe. An original no course uses
is a video that can never be re-encoded — a ladder cannot be rebuilt from the
ladder — and that is a decision.

So `safe` may be cleared in one action; `needsJudgement` may not, and each of its
entries carries the sentence somebody has to read before agreeing to it.

`needsJudgement` holds three offers, and they are separate because what is lost
differs. Dropping an original keeps a video members can still watch. Deleting an
upload that stopped ends a multipart upload R2 is billing for and takes a row
that never became a video. Deleting the whole video takes everything, and it is
the only one that can remove a row — which the back office had no way to do at
all, so a video that should never have existed stayed in the library for good.

A source a lesson still uses is in none of them. Not warned about: there is no
entrance. A warning is a thing somebody clicks past at four in the afternoon.
"""

from domain import source_upload, storage_report, storage_scan, video, video_storage
from shared.common import d1_rows


# How long a replaced encode stays off the list. Going back to the previous
# version is the recovery for a re-encode that turned out wrong, and the hour
# somebody notices is the first one.
ROLLBACK_SECONDS = 7 * 24 * 60 * 60

UNUSED_SOURCE_CONSEQUENCE = "刪除後這支影片無法再重新轉檔"
UNFINISHED_UPLOAD_CONSEQUENCE = "這次上傳沒有完成，刪除後這筆紀錄與已經送出的分段都會消失"
ENTIRE_VIDEO_CONSEQUENCE = "整支影片、所有畫質版本與這筆紀錄都會刪除，無法復原"

# An upload that has not become a video yet. The parts already sent are a
# pending multipart upload — billed, invisible in a listing, and endable only
# through the session row — so removing one of these is a different action from
# removing an original that landed, and it says so.
UNFINISHED = ("uploading", "uploaded", "queued")

# The one state nothing may be removed from. A container is writing this
# asset's objects right now, and whatever it writes after the row is gone
# belongs to nothing at all.
TRANSCODING = "processing"


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

        if source["status"] in UNFINISHED:
            # Not a source to delete and not a video to delete: an upload that
            # stopped. Deleting it takes the row with it, because the row is the
            # whole of what it ever became — and until this existed the back
            # office could only archive it, which is a state, not a removal.
            needs_judgement.append(
                {
                    "kind": "unfinishedUpload",
                    "assetId": source["assetId"],
                    "title": source["title"],
                    "bytes": source["bytes"],
                    "consequence": UNFINISHED_UPLOAD_CONSEQUENCE,
                }
            )
            continue

        if source["status"] == TRANSCODING:
            continue

        # Only when there is something at the key. `hasSourceObject` is the
        # completed upload session, not the size the tool declared: offering the
        # other rows would be a button that deletes nothing and says it worked.
        if source["hasSourceObject"]:
            needs_judgement.append(
                {
                    "kind": "unusedSource",
                    "assetId": source["assetId"],
                    "title": source["title"],
                    "bytes": source["bytes"],
                    "consequence": UNUSED_SOURCE_CONSEQUENCE,
                }
            )

        # And the whole thing, which is the only offer that can remove the row.
        # Deliberately beside the one above rather than instead of it: keeping a
        # working video while dropping its original is a different decision from
        # deciding the video should not exist, and a screen that offers only the
        # second turns "reclaim 4 GB" into "delete the lesson".
        needs_judgement.append(
            {
                "kind": "entireVideo",
                "assetId": source["assetId"],
                "title": source["title"],
                "bytes": source["bytes"] + source["versionBytes"],
                "consequence": ENTIRE_VIDEO_CONSEQUENCE,
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


async def _keys_under(env, *, kind: str, prefix: str, limit: int | None = None) -> tuple[list[str], bool]:
    """Every object under this prefix, and whether that is really all of them.

    Paged, because a listing answers at most a couple of hundred at a time and a
    ladder is more than that. The second value is what stops the caller removing
    the row that names objects it did not manage to delete: an object nothing
    records is exactly the orphan this whole feature exists to stop making.

    `limit` is read at call time rather than defaulted to `MAX_DELETES` in the
    signature, so a caller spending one budget across several prefixes can say
    what is left of it — and so a test that lowers the ceiling still lowers it.
    """

    limit = MAX_DELETES if limit is None else limit
    keys: list[str] = []
    cursor = None
    while len(keys) < limit:
        listing = await video_storage.list_objects(env, kind=kind, prefix=prefix, cursor=cursor)
        keys.extend(item["key"] for item in listing["objects"])
        cursor = listing["cursor"]
        if not listing["truncated"] or not cursor:
            # One page can hand back more than the budget, and the extra is not
            # deleted. Saying "complete" then would be the row going while its
            # objects stayed.
            return keys[:limit], len(keys) <= limit
    return keys[:limit], False


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


async def _purge(env, *, targets, dry_run: bool) -> tuple[list[str], bool]:
    """Empty several prefixes under one budget, and say whether they are empty.

    One budget rather than one each: the ceiling exists because every deletion
    is a request and this has to finish inside a single Worker invocation, and
    two prefixes each allowed the whole of it is twice the work the number was
    chosen to bound.
    """

    removed: list[str] = []
    complete = True
    for kind, prefix in targets:
        budget = MAX_DELETES - len(removed)
        if budget <= 0:
            complete = False
            break
        keys, whole = await _keys_under(env, kind=kind, prefix=prefix, limit=budget)
        removed.extend(await _remove(env, kind=kind, keys=keys, dry_run=dry_run))
        complete = complete and whole
    return removed, complete


async def _asset_or_refuse(env, asset_id: str, *, action: str) -> dict:
    """The asset, if no course lesson plays it.

    The references are read here rather than taken from the list that offered
    the deletion. A lesson can start using a video between a page loading and a
    button being pressed, and the page is not the authority — nor is it the
    thing that has to be right. The list hides these; this is what makes hiding
    them a rule instead of a habit.
    """

    asset = await video.get_asset(env, asset_id)
    if asset is None:
        raise LookupError("Video not found")

    lessons = await video.lessons_using(env, asset_id)
    if lessons:
        names = "、".join(lesson["title"] for lesson in lessons[:3])
        raise ValueError(f"這支影片正被單元「{names}」使用，不能{action}")
    return asset


async def delete_source(env, *, asset_id: str, dry_run: bool = False, now: int) -> dict:
    """Remove an original nothing uses, and leave the video playable."""

    asset = await _asset_or_refuse(env, asset_id, action="刪除原始檔")
    if asset["status"] == "uploading":
        # Mid-transfer. Its objects are being written right now, and the parts
        # already sent belong to a session that can still finish.
        raise ValueError("這支影片還在上傳中，不能刪除原始檔")

    keys, complete = await _keys_under(env, kind="source", prefix=video.source_prefix(asset_id, 1))
    return {
        "assetId": asset_id,
        "deleted": await _remove(env, kind="source", keys=keys, dry_run=dry_run),
        "complete": complete,
        "dryRun": dry_run,
    }


LIVE_SESSIONS_SQL = (
    "SELECT * FROM video_upload_sessions WHERE asset_id = ?1 AND status = 'uploading'"
)

# The rows one video owns, children first. A run that dies partway leaves the
# asset row, which is the one somebody can see and press again; the other order
# leaves rows describing a video that is not there.
DELETE_ASSET_VERSIONS_SQL = "DELETE FROM video_encode_versions WHERE asset_id = ?1"
DELETE_ASSET_SESSIONS_SQL = "DELETE FROM video_upload_sessions WHERE asset_id = ?1"
# The jobs go too. A queued transcode naming an asset that no longer exists is
# work the pipeline would pick up and fail at, repeatedly and for no reason.
DELETE_ASSET_JOBS_SQL = "DELETE FROM video_transcode_jobs WHERE asset_id = ?1"
DELETE_ASSET_SQL = "DELETE FROM video_assets WHERE id = ?1"


async def _delete_rows(env, asset_id: str) -> None:
    for statement in (
        DELETE_ASSET_VERSIONS_SQL,
        DELETE_ASSET_SESSIONS_SQL,
        DELETE_ASSET_JOBS_SQL,
        DELETE_ASSET_SQL,
    ):
        await env.DB.prepare(statement).bind(asset_id).run()


async def delete_upload(env, *, asset_id: str, dry_run: bool = False, now: int) -> dict:
    """Remove an upload that stopped, and the invisible bytes it is holding.

    A pending multipart upload is not in any listing and is billed all the same,
    and the session row holds the only id that can end one. So the cancelling
    happens before the row goes: delete the row first and those parts are
    storage nothing in this system can name, let alone reach.

    The asset row goes with it, because for an upload that never finished the
    row is the whole of what it became. Archiving is what the library offered
    instead, and archiving is a state, not a removal.
    """

    asset = await _asset_or_refuse(env, asset_id, action="刪除")
    if asset["status"] not in UNFINISHED:
        raise ValueError("這支影片的上傳已經結束，請改用刪除整支影片")

    sessions = await d1_rows(env.DB.prepare(LIVE_SESSIONS_SQL).bind(asset_id))
    if not dry_run:
        for session in sessions:
            # Raises if R2 will not let go of it, which stops the row being
            # deleted. A row somebody can see and press again is recoverable;
            # a pending upload nothing remembers the id of is not.
            await source_upload.abort(env, session=session, now=now)

    deleted, complete = await _purge(
        env, targets=[("source", video.asset_prefix(asset_id, kind="source"))], dry_run=dry_run
    )

    rows_removed = 0
    if not dry_run and complete:
        await _delete_rows(env, asset_id)
        rows_removed = 1

    return {
        "assetId": asset_id,
        "deleted": deleted,
        "sessionsCancelled": 0 if dry_run else len(sessions),
        "rowsRemoved": rows_removed,
        "complete": complete,
        "dryRun": dry_run,
    }


async def delete_asset(env, *, asset_id: str, dry_run: bool = False, now: int) -> dict:
    """Remove a whole video: its original, every encode, and the row.

    Both prefixes rather than the versions D1 knows about. A version whose row
    was never written is exactly the one worth removing, and walking the
    recorded ones would leave it behind while deleting the row that could still
    have led somebody to it.

    Refused for a video a lesson plays, and refused while a container is writing
    its objects. Both are checked here rather than only in the list, because the
    list is a suggestion and this is the rule.
    """

    asset = await _asset_or_refuse(env, asset_id, action="刪除整支影片")
    if asset["status"] == TRANSCODING:
        raise ValueError("這支影片正在轉檔，請等轉檔結束或先讓它失敗")
    if asset["status"] in UNFINISHED:
        # Sent to the other door rather than handled here. This one does not
        # cancel pending multipart uploads, and taking the session rows away
        # from one would leave R2 holding parts whose id nothing remembers.
        raise ValueError("這支影片還沒上傳完成，請改用刪除這筆上傳")

    deleted, complete = await _purge(
        env,
        targets=[
            ("output", video.asset_prefix(asset_id, kind="output")),
            ("source", video.asset_prefix(asset_id, kind="source")),
        ],
        dry_run=dry_run,
    )

    rows_removed = 0
    if not dry_run and complete:
        # Only once every object is gone, the same order `delete_version` keeps.
        # A failed purge should leave a visible row, not unfindable bytes.
        await _delete_rows(env, asset_id)
        rows_removed = 1

    return {
        "assetId": asset_id,
        "deleted": deleted,
        "rowsRemoved": rows_removed,
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
