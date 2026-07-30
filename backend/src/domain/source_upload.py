"""The original file's own upload, which is not like the encode's.

The HLS objects are hundreds of small independent PUTs: each one either lands or
is retried, and nothing is left behind if the tool gives up halfway. A source
file is one object of several gigabytes, so it goes up as a multipart upload —
and a multipart upload is *state R2 holds on our behalf*. Parts already sent are
billed as storage, they are invisible in a bucket listing, and they stay until
somebody completes or cancels the upload.

So this is a session rather than a URL. The row exists to answer three questions
nothing else can: which R2 upload id belongs to this asset, how the tool was told
to cut the file, and whether the upload is still one somebody may write to.

The parts themselves are still presigned URLs — those are the bytes, and they
must not pass through the Worker.
"""

from domain import video
from shared import r2_s3, sigv4
from shared.common import d1_changed, d1_rows, urlsafe_token, utc_timestamp
from domain.video_storage import URL_TTL, bucket_for, credentials_for


# Long enough for a home connection to push several gigabytes, and short enough
# that an abandoned session stops holding a slot. It bounds this row, not the
# pending upload in R2 — that ends only when something completes or cancels it,
# which is why an expired session still has to be cancelled rather than forgotten.
SESSION_TTL = 12 * 60 * 60

# Every live session is a pending multipart upload, billed and not visible in a
# listing. The cap is what stops a retrying tool from opening hundreds of them.
#
# Counted across the whole account rather than per asset, because that is the
# shape of what it bounds: invisible storage R2 is holding for us. Two admins
# sharing five concurrent source uploads is not a limit either of them will
# meet; a tool in a retry loop meets it immediately, which is the point.
#
# The count and the insert are not one statement, so two requests arriving
# together can both see room and both take it. Bounded by one, not exactly — and
# an off-by-one on a limit whose purpose is "not hundreds" is not worth a lock.
MAX_LIVE_SESSIONS = 5

STATUSES = ("uploading", "completed", "aborted")

# The upload version a source lands under. One today: re-uploading an original is
# not a flow that exists, and a second version would need somewhere to say which
# one an asset's `source_key` points at.
UPLOAD_VERSION = 1


def session_row(row: dict) -> dict:
    """What the back office and the tool may know about a session.

    No upload id: it is the credential that lets somebody act on the pending
    upload, and every route that needs one reads it from D1 rather than taking
    it from a caller.
    """

    return {
        "sessionId": row["id"],
        "assetId": row["asset_id"],
        "partSize": int(row["part_size"]),
        "partCount": int(row["part_count"]),
        "status": row["status"],
        "expiresAt": int(row["expires_at"]),
    }


async def get_session(env, session_id: str, *, asset_id: str) -> dict | None:
    """The row, or nothing — matched on the asset as well as the id.

    A session id alone would let a caller name somebody else's session while
    holding a token for their own asset.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT * FROM video_upload_sessions WHERE id = ?1 AND asset_id = ?2"
        ).bind(session_id, asset_id)
    )
    return rows[0] if rows else None


# Which sessions stand in the way of opening a new one. A fake database returns
# whatever a test declared for a matching statement, so the `!= 'aborted'` is
# only exercised where SQL is actually evaluated — hence the constant.
ASSET_SESSIONS_SQL = (
    "SELECT id, status FROM video_upload_sessions WHERE asset_id = ?1 AND status != 'aborted'"
)


async def sessions_for(env, asset_id: str) -> list[dict]:
    """Sessions for this asset that are not cancelled.

    A cancelled one leaves nothing behind, so it does not stand in the way of
    trying again; a live or completed one does.
    """

    return await d1_rows(env.DB.prepare(ASSET_SESSIONS_SQL).bind(asset_id))


async def live_sessions(env, now: int) -> int:
    rows = await d1_rows(
        env.DB.prepare(
            "SELECT COUNT(*) AS live FROM video_upload_sessions"
            " WHERE status = 'uploading' AND expires_at > ?1"
        ).bind(now)
    )
    return int(rows[0]["live"]) if rows else 0


async def start(env, *, asset: dict, now: int | None = None) -> dict:
    """Open a multipart upload for this asset's original, and remember it.

    R2 is asked first and the row is written second. The other order leaves a
    session whose complete and abort can never succeed, because the id they need
    was never issued — and that row would also occupy one of the slots below.
    """

    if asset["status"] != "uploading":
        raise ValueError("這支影片已經不在上傳中")

    now = utc_timestamp() if now is None else now
    # One original per asset, so one session that ever finished. Every session
    # for an asset writes the same key, which is also what makes the "did the
    # object appear" test in `complete` mean anything: with a second session
    # allowed, an earlier upload's object would answer for a later one that
    # never finished.
    if await sessions_for(env, asset["id"]):
        raise ValueError("這支影片已經有原始檔上傳，請先取消或改用重新轉檔")
    if await live_sessions(env, now) >= MAX_LIVE_SESSIONS:
        raise ValueError(f"同時最多 {MAX_LIVE_SESSIONS} 個原始檔上傳，請先完成或取消其中一個")

    byte_size = video.validate_byte_size(asset["byteSize"])
    part_size = video.part_size_for(byte_size)
    part_count = video.part_count_for(byte_size, part_size)
    key = video.source_key(asset["id"], UPLOAD_VERSION)

    upload_id = await r2_s3.start_multipart(
        credentials=credentials_for(env),
        bucket=bucket_for(env, "source"),
        key=key,
        now=now,
    )

    session_id = urlsafe_token(18)
    expires_at = now + SESSION_TTL
    try:
        await env.DB.prepare(
            "INSERT INTO video_upload_sessions (id, asset_id, upload_id, part_size, part_count,"
            " status, etag, expires_at, created_at, updated_at)"
            " VALUES (?1, ?2, ?3, ?4, ?5, 'uploading', NULL, ?6, ?7, ?7)"
        ).bind(session_id, asset["id"], upload_id, part_size, part_count, expires_at, now).run()
    except Exception:
        # The upload exists in R2 and nothing will ever name it: no row means no
        # complete, no abort, and nothing for a cleanup job to find either. Best
        # effort, and the original failure is what the caller hears about.
        try:
            await r2_s3.abort_multipart(
                credentials=credentials_for(env),
                bucket=bucket_for(env, "source"),
                key=key,
                upload_id=upload_id,
                now=now,
            )
        except Exception:
            pass
        raise

    return {
        "sessionId": session_id,
        "partSize": part_size,
        "partCount": part_count,
        "expiresAt": expires_at,
    }


def usable(session: dict, now: int) -> None:
    """Whether this session may still be written to. Raises rather than returns.

    A caller who forgets to check a boolean signs a URL anyway, and there is no
    safe default here.
    """

    if session["status"] != "uploading":
        raise ValueError("這次上傳已經結束")
    if int(session["expires_at"]) <= now:
        raise ValueError("這次上傳已經逾時，請重新開始")


class InvalidParts(ValueError):
    """The part list is not one. A malformed request, not a state conflict."""


def _reported_parts(parts) -> list[tuple[int, str]]:
    """What the tool says it uploaded, in the shape the S3 client takes.

    Each part's ETag comes back to the tool in the PUT response and comes here in
    the complete request, so this list is the one thing about the finished object
    that is the caller's word. It is checked for shape only — `r2_s3` checks the
    values, and R2 checks whether they are the parts it actually holds.
    """

    if not isinstance(parts, list) or not parts:
        raise InvalidParts("沒有已完成的分段可以合併")

    reported = []
    for part in parts:
        if not isinstance(part, dict):
            raise InvalidParts("分段格式不正確")
        number, etag = part.get("partNumber"), part.get("eTag")
        if isinstance(number, bool) or not isinstance(number, int):
            raise InvalidParts("分段編號必須是整數")
        if not isinstance(etag, str) or not etag.strip():
            raise InvalidParts(f"分段 {number} 沒有 ETag")
        reported.append((number, etag.strip()))
    return reported


# Ending a session, and only from the state it was read in. Two requests can
# arrive together — a tool completing while an admin cancels — and the last write
# would otherwise win regardless of which one R2 actually acted on. A fake
# database reports a row changed whatever this clause says, so it is a constant
# the real-SQLite tests import.
SETTLE_SQL = (
    "UPDATE video_upload_sessions SET status = ?2, etag = COALESCE(?3, etag), updated_at = ?4"
    " WHERE id = ?1 AND status = 'uploading'"
)


async def _settle(env, *, session: dict, status: str, etag: str | None, now: int) -> None:
    """End the session, or say that somebody else already did.

    The answer is checked rather than discarded. A tool completing while an admin
    cancels is one request per outcome, and the loser writing nothing while still
    reporting its own outcome tells one of them something untrue.
    """

    result = await env.DB.prepare(SETTLE_SQL).bind(session["id"], status, etag, now).run()
    if not d1_changed(result):
        raise ValueError("這次上傳的狀態已經改變，請重新讀取")


async def complete(env, *, asset: dict, session: dict, parts, now: int | None = None) -> dict:
    """Assemble the parts into the asset's original.

    Idempotent, and it has to be done here rather than by asking R2 twice: a
    completed upload's id stops existing, so a second complete answers
    `NoSuchUpload` — the same answer as for an id that never existed. The row
    remembers the tag, so a retry that arrives after a lost answer is answered
    from D1 without touching R2.

    When the row does not know either — the first attempt's answer was the thing
    that was lost — the object is the evidence. R2 saying `NoSuchUpload` while an
    object sits at the key means the assembly worked and the reply did not.
    """

    now = utc_timestamp() if now is None else now
    # The session's expiry is deliberately not checked. It bounds how long parts
    # may be signed for, not how long the tool has to say it finished — an upload
    # that took longer than the window still produced an object, and refusing to
    # record it would leave the bytes paid for and unusable.
    if asset["status"] != "uploading":
        raise ValueError("這支影片已經不在上傳中")
    if session["status"] == "completed":
        return {"etag": session["etag"] or "", "alreadyCompleted": True}
    if session["status"] != "uploading":
        raise ValueError("這次上傳已經取消，請重新開始")

    reported = _reported_parts(parts)
    key = video.source_key(session["asset_id"], UPLOAD_VERSION)
    credentials = credentials_for(env)
    bucket = bucket_for(env, "source")

    try:
        etag = await r2_s3.complete_multipart(
            credentials=credentials,
            bucket=bucket,
            key=key,
            upload_id=session["upload_id"],
            parts=reported,
            now=now,
        )
    except r2_s3.R2Error as error:
        if error.code not in r2_s3.GONE_CODES:
            raise
        stored = await env.COURSE_SOURCE.head(key)
        if stored is None:
            # Nothing was assembled and the upload is not there to finish. The
            # tool has to start again, and saying so beats a success it cannot
            # act on.
            raise
        etag = str(getattr(stored, "etag", "") or "")

    await _settle(env, session=session, status="completed", etag=etag, now=now)
    return {"etag": etag, "alreadyCompleted": False}


async def abort(env, *, session: dict, now: int | None = None) -> None:
    """Cancel a pending upload, and stop it costing anything.

    Idempotent for the same reason abort is in `r2_s3`: the retry is ordinary.
    An expired session may still be cancelled — the row's window is over but the
    pending upload in R2 is not, and refusing here would leave the only thing
    that can end it unreachable.

    A completed upload is refused rather than cancelled. The object exists and is
    the asset's original; "cancel" would either do nothing or delete it, and
    neither is what the word says.
    """

    now = utc_timestamp() if now is None else now
    if session["status"] == "aborted":
        return
    if session["status"] != "uploading":
        raise ValueError("這次上傳已經完成，不能取消")

    await r2_s3.abort_multipart(
        credentials=credentials_for(env),
        bucket=bucket_for(env, "source"),
        key=video.source_key(session["asset_id"], UPLOAD_VERSION),
        upload_id=session["upload_id"],
        now=now,
    )
    await _settle(env, session=session, status="aborted", etag=None, now=now)


def part_url(env, *, asset: dict, session: dict, part_number: int, now: int | None = None) -> dict:
    """A short-lived PUT URL for one part of this upload.

    The part number is checked against the count the session was opened with, so
    a tool cannot write past the end of the file it declared — the size decides
    the count, and the size is what the asset was created with.

    The asset is checked as well as the session, because abandoning an upload
    retires the asset rather than the session row. Without this, a tool already
    holding a session would go on writing into the original of a video the back
    office has finished with.
    """

    now = utc_timestamp() if now is None else now
    if asset["status"] != "uploading":
        raise ValueError("這支影片已經不在上傳中")
    usable(session, now)
    video.validate_part_number(part_number, part_count=int(session["part_count"]))

    return {
        "partNumber": part_number,
        "url": sigv4.presigned_multipart_url(
            operation="part",
            bucket=bucket_for(env, "source"),
            key=video.source_key(session["asset_id"], UPLOAD_VERSION),
            upload_id=session["upload_id"],
            part_number=part_number,
            now=now,
            expires=URL_TTL,
            **credentials_for(env),
        ),
        "expiresAt": now + URL_TTL,
    }
