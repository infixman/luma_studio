"""Course video: arithmetic, keys and states.

The bytes never pass through this Worker. The browser uploads parts straight
to private R2 using short-lived signed URLs, which is the only way a two-hour
lesson gets uploaded at all — a Worker request body is not the place for it.
So what lives here is the part that decides *where* things go and *when* a
change is allowed, and none of it touches a credential.

Three rules shape everything below.

R2 accepts at most 10,000 parts and refuses any part under 5 MiB except the
last. A part size picked without regard to those fails at the end of a long
upload rather than at the start, which is the most expensive time to find out.

Object keys are derived from ids, never from filenames. A filename is
attacker-controlled, frequently not a legal path, and occasionally an attempt
to write somewhere else entirely.

Outputs are versioned. Re-encoding happens beside the version members are
watching, and the new one only becomes live once every object in it is
verified — a half-written ladder a player could select is worse than an old
one that works.
"""

import re

from shared.common import d1_changed, d1_rows, urlsafe_token, utc_timestamp
from shared.sigv4 import MAX_PART_NUMBER


MIB = 1024 * 1024

# R2's multipart limits. Both are the service's, not ours.
MIN_PART_SIZE = 5 * MIB
# One copy of the ceiling, for the same reason `validate_byte_size` gives for
# the size one: two would eventually disagree, and the way they disagree is an
# upload that starts and cannot finish. The signer owns it because it is the
# side that refuses a part number, and `shared` cannot import `domain`.
MAX_PARTS = MAX_PART_NUMBER

# Ours: a course lesson beyond this is a mistake or a misuse, and either way
# the pipeline should say so before the upload rather than during it.
MAX_UPLOAD_BYTES = 20 * 1024 * MIB

# Also ours, and for the same reason in the other dimension: transcoding runs on
# somebody's laptop at roughly real time per rung, so a twelve-hour file is a
# machine occupied for a day and a half. Generous enough that a long workshop
# recording fits; small enough that a wrong file says so before the encode.
MAX_DURATION_SECONDS = 6 * 60 * 60

ASSET_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,40}$")
OUTPUT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$")
OUTPUT_SUFFIXES = (".m3u8", ".mp4", ".m4s", ".webp")

# The ladder, largest first. Bitrates and keyframe settings belong with the
# encoder; what matters here is the names, because they are in object keys.
RENDITIONS = (("1080p", 1080), ("720p", 720), ("480p", 480))
RENDITION_NAMES = tuple(name for name, _ in RENDITIONS)
_RENDITIONS = "|".join(RENDITION_NAMES)

# Exactly the objects an encode consists of, relative to its own folder.
#
# Two things with opposite failure modes read this list: the signer decides
# what the desktop tool may write, the gateway decides what a member may read.
# A second copy would drift, and on the day it drifted one side would accept
# an object the other refuses.
#
# An allowlist of shapes rather than a denylist of traversal tricks. Every list
# of tricks is missing one, and these names are entirely predictable.
OBJECT_PATTERNS = (
    re.compile(r"^master\.m3u8$"),
    re.compile(r"^poster\.webp$"),
    re.compile(rf"^(?:{_RENDITIONS})/playlist\.m3u8$"),
    re.compile(rf"^(?:{_RENDITIONS})/init\.mp4$"),
    re.compile(rf"^(?:{_RENDITIONS})/segment-\d{{6}}\.m4s$"),
)

# Which bucket a key belongs to. Not a default anywhere: adding a third means
# deciding what may be written to it.
KINDS = ("source", "output")

STATUSES = ("uploading", "uploaded", "queued", "processing", "ready", "failed", "aborted", "archived")

# The two endings. An asset in one of these is finished with by somebody's
# decision, which is why `import` refuses to write over it: registering an encode
# goes straight to `ready` and would otherwise undo that decision silently.
RETIRED = ("aborted", "archived")

# Every move the pipeline actually makes, and nothing else. Written as a table
# because the interesting part is what is missing: nothing reaches `ready`
# without having been `processing`, and nothing comes back from `archived`.
TRANSITIONS = {
    "uploading": ("uploaded", "aborted"),
    "uploaded": ("queued", "aborted"),
    "queued": ("processing", "failed", "aborted"),
    "processing": ("ready", "failed"),
    # Retrying is deliberate and manual; a permanent failure should not spin.
    "failed": ("queued", "archived"),
    # A new encode version, or the end of its useful life.
    "ready": ("queued", "archived"),
    "aborted": (),
    "archived": (),
}


def validate_byte_size(byte_size) -> int:
    """A size this pipeline will accept, refused before the upload rather than
    during it.

    One copy of the ceiling. Two would eventually disagree, and the way they
    would disagree is an upload that starts and cannot finish.
    """

    if not isinstance(byte_size, int) or isinstance(byte_size, bool) or byte_size <= 0:
        raise ValueError("影片大小必須是正整數")
    if byte_size > MAX_UPLOAD_BYTES:
        raise ValueError(f"單一影片不能超過 {MAX_UPLOAD_BYTES // (1024 * MIB)} GiB")
    return byte_size


def validate_duration(duration_seconds):
    """A length this pipeline will accept, or nothing.

    Absent stays absent — ffprobe not reading a duration is a normal answer for
    an odd file, and the ladder does not depend on it. What is refused is a
    number that means the wrong file was dropped in: the encode is real time per
    rung on somebody's machine, so the cost of finding out later is a day of it.
    """

    if duration_seconds is None:
        return None
    if isinstance(duration_seconds, bool) or not isinstance(duration_seconds, int) or duration_seconds < 0:
        raise ValueError("影片長度必須是整數秒")
    if duration_seconds > MAX_DURATION_SECONDS:
        raise ValueError(f"單一影片不能超過 {MAX_DURATION_SECONDS // 3600} 小時")
    return duration_seconds


def part_size_for(byte_size: int) -> int:
    """The part size this upload should use.

    Rounded up to whole mebibytes so the client's arithmetic and ours cannot
    disagree at the final part, which is the one place a mismatch costs the
    entire upload.
    """

    byte_size = validate_byte_size(byte_size)

    # Smallest legal part that still fits the file into the part limit.
    needed = -(-byte_size // MAX_PARTS)
    size = max(MIN_PART_SIZE, needed)
    return -(-size // MIB) * MIB


def part_count_for(byte_size: int, part_size: int) -> int:
    return -(-byte_size // part_size)


def validate_part_number(value, *, part_count: int) -> int:
    """Part numbers start at 1, as S3 requires.

    A zero passes every naive check and then fails at CompleteMultipartUpload,
    long after the bytes have been sent.
    """

    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Part number must be a whole number")
    if value < 1 or value > part_count:
        raise ValueError(f"Part number must be between 1 and {part_count}")
    return value


def _asset_id(asset_id: str) -> str:
    if not isinstance(asset_id, str) or not ASSET_ID_PATTERN.fullmatch(asset_id):
        raise ValueError("Invalid asset id")
    return asset_id


def _version(version) -> int:
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError("Encode version must be a positive whole number")
    return version


def source_prefix(asset_id: str, upload_version: int) -> str:
    """Where an original lands.

    Named after the asset, not the file. `../../` in a filename is a real thing
    people send, and a key built from one is a write to wherever the uploader
    chose.
    """

    return f"sources/{_asset_id(asset_id)}/{_version(upload_version)}/"


def encode_prefix(asset_id: str, encode_version: int) -> str:
    """Where one encode's objects live.

    Every key, the verifier and the playback gateway derive from this, so the
    asset id and version are validated once, here, rather than in five places
    that could disagree.
    """

    return f"videos/{_asset_id(asset_id)}/{_version(encode_version)}/"


def source_key(asset_id: str, upload_version: int) -> str:
    return f"{source_prefix(asset_id, upload_version)}source.mp4"


def master_key(asset_id: str, encode_version: int) -> str:
    return f"{encode_prefix(asset_id, encode_version)}master.m3u8"


def poster_key(asset_id: str, encode_version: int) -> str:
    return f"{encode_prefix(asset_id, encode_version)}poster.webp"


def rendition_key(asset_id: str, encode_version: int, rendition: str, name: str) -> str:
    if rendition not in RENDITION_NAMES:
        raise ValueError(f"Unknown rendition: {rendition}")
    if not isinstance(name, str) or not OUTPUT_NAME_PATTERN.fullmatch(name):
        raise ValueError("Invalid output name")
    if not name.endswith(OUTPUT_SUFFIXES):
        raise ValueError("Invalid output type")
    return f"{encode_prefix(asset_id, encode_version)}{rendition}/{name}"


def allowed_object(path: str) -> bool:
    """Whether this is an object an encode actually contains.

    Consulted by the signer before writing and by the gateway before reading.
    """

    if not isinstance(path, str) or not path:
        return False
    return any(pattern.fullmatch(path) for pattern in OBJECT_PATTERNS)


def signable_key(key: str, *, asset_id: str, version: int, kind: str) -> str:
    """The key, if it is one this asset and version may be handed a URL for.

    A presigned URL is the entirety of what the desktop tool can do to a
    bucket, so this is where "one object, this asset, this version" is decided.
    Two refusals matter more than the rest: another asset's prefix, which would
    let one upload write into somebody else's video, and another version of
    this asset, which would let a caller claiming to upload a new encode write
    into the one members are watching.

    Raises rather than returning False. A caller who forgets to check a boolean
    signs whatever they were given, and there is no safe default to fall back
    on here.
    """

    if kind not in KINDS:
        raise ValueError(f"Unknown object kind: {kind}")
    if not isinstance(key, str) or not key:
        raise ValueError("Object key is required")

    if kind == "source":
        # One object, and its name is not up for discussion.
        if key != source_key(asset_id, version):
            raise ValueError("This key is not this asset's original")
        return key

    prefix = encode_prefix(asset_id, version)
    if not key.startswith(prefix) or not allowed_object(key[len(prefix) :]):
        raise ValueError("This key is not part of this encode")
    return key


def can_change(before: str, after: str) -> bool:
    """Whether the pipeline is allowed to make this move.

    Consulted before the conditional UPDATE rather than instead of it: this
    answers "is this a sensible move", the WHERE clause answers "is the row
    still where we thought it was".
    """

    return after in TRANSITIONS.get(before, ())


def ladder_for(*, height: int) -> list[str]:
    """Which renditions to produce for a source of this height.

    Never larger than the source. Upscaling spends bandwidth and storage to
    deliver a blurrier file than the one that came in.

    A source shorter than the smallest rung still gets that rung, because the
    encoder will letterbox down to it rather than up: something playable beats
    an asset with no ladder at all.
    """

    if isinstance(height, bool) or not isinstance(height, int) or height <= 0:
        raise ValueError("來源影片高度無法辨識")
    fitting = [name for name, rung in RENDITIONS if rung <= height]
    return fitting or [RENDITION_NAMES[-1]]


def asset_row(row: dict) -> dict:
    """What the back office is allowed to know about an asset.

    No object keys. These rows travel over the network to a browser, and a key
    is a thing to go looking for — the bucket is private, but publishing the
    map is still a favour nobody asked for. The player gets its URLs from the
    playback gateway in phase 6, signed and short-lived.
    """

    return {
        "id": row["id"],
        "title": row["title"],
        "originalFilename": row["original_filename"],
        "status": row["status"],
        "byteSize": int(row["byte_size"]),
        "durationSeconds": None if row["duration_seconds"] is None else int(row["duration_seconds"]),
        "width": None if row["width"] is None else int(row["width"]),
        "height": None if row["height"] is None else int(row["height"]),
        "encodeVersion": None if row["active_encode_version"] is None else int(row["active_encode_version"]),
        "hasPoster": row["poster_key"] is not None,
        "errorCode": row["error_code"],
        "errorDetail": row["error_detail"],
        "createdAt": int(row["created_at"]),
        "updatedAt": int(row["updated_at"]),
    }


async def get_asset(env, asset_id: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM video_assets WHERE id = ?1").bind(asset_id))
    return asset_row(rows[0]) if rows else None


async def list_assets(env, *, status: str | None = None) -> list[dict]:
    query = "SELECT * FROM video_assets"
    bindings: list = []
    if status is not None:
        query += " WHERE status = ?1"
        bindings.append(status)
    query += " ORDER BY created_at DESC LIMIT 200"
    return [asset_row(row) for row in await d1_rows(env.DB.prepare(query).bind(*bindings))]


async def change_status(
    env,
    asset_id: str,
    to_status: str,
    *,
    error_code: str | None = None,
    error_detail: str | None = None,
) -> bool:
    """Move an asset one step, if the move is legal and the row has not moved.

    Two checks, and both are needed. `can_change` answers "is this a move the
    pipeline makes at all", which is a question about the code. The status in
    the WHERE clause answers "is the row still where it was read", which is a
    question about the other request that arrived while this one was thinking.

    Reaching `ready` clears any recorded error: a retry that worked must not
    leave last week's failure on the screen.
    """

    rows = await d1_rows(env.DB.prepare("SELECT * FROM video_assets WHERE id = ?1").bind(asset_id))
    if not rows:
        return False
    before = rows[0]["status"]
    if not can_change(before, to_status):
        return False

    now = utc_timestamp()
    if to_status == "ready":
        statement = (
            "UPDATE video_assets SET status = ?2, error_code = NULL, error_detail = NULL, updated_at = ?3"
            " WHERE id = ?1 AND status = ?4"
        )
        result = await env.DB.prepare(statement).bind(asset_id, to_status, now, before).run()
    else:
        statement = (
            "UPDATE video_assets SET status = ?2, error_code = ?5, error_detail = ?6, updated_at = ?3"
            " WHERE id = ?1 AND status = ?4"
        )
        result = await env.DB.prepare(statement).bind(
            asset_id, to_status, now, before, error_code, error_detail
        ).run()
    return d1_changed(result)


async def publish_encode(env, asset_id: str, *, encode_version: int, master: str, poster: str | None) -> bool:
    """Make a finished encode the one members get.

    Called only after every object in the version has been verified. Doing it
    earlier means a player can select a ladder that is still being written,
    and the failure looks like a corrupt video rather than a missing one.
    """

    result = await env.DB.prepare(
        "UPDATE video_assets SET active_encode_version = ?2, master_key = ?3, poster_key = ?4,"
        " status = 'ready', error_code = NULL, error_detail = NULL, updated_at = ?5"
        " WHERE id = ?1 AND status = 'processing'"
    ).bind(asset_id, _version(encode_version), master, poster, utc_timestamp()).run()
    return d1_changed(result)


async def lessons_using(env, asset_id: str) -> list[dict]:
    """Which course lessons play this video.

    Asked before archiving. Archiving one a published lesson still uses would
    leave that lesson pointing at nothing, and the failure would surface as a
    member unable to watch rather than as an admin action that was refused.
    """

    rows = await d1_rows(
        env.DB.prepare(
            "SELECT id, section_id, title FROM course_lessons WHERE video_asset_id = ?1"
        ).bind(asset_id)
    )
    return [{"id": row["id"], "sectionId": row["section_id"], "title": row["title"]} for row in rows]


# The WHERE clause is the whole point, so it is a constant a real-SQLite test can
# import: the status read a moment ago has to still be the row's status. A fake
# database reports one row changed whatever the clause says.
RETIRE_SQL = "UPDATE video_assets SET status = ?2, updated_at = ?4 WHERE id = ?1 AND status = ?3"


async def retire_asset(env, asset_id: str, to_status: str) -> bool:
    """Take a video out of use, one way or the other.

    Two endings, one statement. `archived` is for a video that was something and
    is finished with; `aborted` is for an upload that never became one. The state
    table decides which is available from where, and the status in the WHERE
    clause decides whether the row is still where it was read.

    Unlike `change_status` this leaves `error_code` and `error_detail` alone.
    Retiring a failed asset is often *because* it failed, and clearing the reason
    on the way out removes the only record of it.

    That difference is also why the target is checked here rather than left to
    `can_change`: `processing -> ready` is a legal move, and making it through
    this function would publish a video while quietly keeping last week's error
    on the row. This is the retirement door, not a general status write.
    """

    if to_status not in RETIRED:
        raise ValueError(f"Not a way to retire a video: {to_status}")

    rows = await d1_rows(env.DB.prepare("SELECT status FROM video_assets WHERE id = ?1").bind(asset_id))
    if not rows or not can_change(rows[0]["status"], to_status):
        return False
    result = await env.DB.prepare(RETIRE_SQL).bind(
        asset_id, to_status, rows[0]["status"], utc_timestamp()
    ).run()
    return d1_changed(result)


def _playlist_entries(text: str) -> list[str]:
    """The non-comment lines of a playlist.

    A playlist is a file somebody uploaded, so nothing here trusts its shape.
    Blank lines and tags are skipped; everything else is treated as a path the
    caller will try to fetch, which is why the caller has to check it.
    """

    if not isinstance(text, str) or not text.lstrip().startswith("#EXTM3U"):
        # Not a playlist. Returning its lines would hand the caller a list of
        # paths made of whatever the file happened to contain.
        return []
    return [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]


def renditions_in(master: str) -> list[str]:
    """The rendition playlists a master refers to."""

    return _playlist_entries(master)


def segments_in(playlist: str) -> list[str]:
    """Everything a rendition playlist needs, including the init segment.

    The init segment lives in an `EXT-X-MAP` tag rather than on a line of its
    own, and a player that has every segment without it can decode none of
    them — so it is easy to leave out of a check and expensive to.
    """

    found = _playlist_entries(playlist)
    for line in playlist.splitlines():
        if line.startswith("#EXT-X-MAP:"):
            _, _, rest = line.partition("URI=")
            uri = rest.strip().strip('"').split(",")[0].strip('"')
            if uri:
                found.insert(0, uri)
    return found


def _safe_relative(path: str) -> bool:
    """Whether a playlist entry stays inside its own encode.

    Following `../` out of one would let an uploaded file point the verifier —
    and later anything reading from it — at any object in the bucket.
    """

    return bool(path) and ".." not in path.split("/") and not path.startswith("/")


def _object_bytes(stored) -> int:
    """What R2 says this object weighs, and zero if it will not say.

    Tolerant on purpose. The object count decides whether the video plays; the
    byte total is for the storage page, which exists so somebody remembers to
    clean up. Refusing an encode because one HEAD came back without a usable
    size would turn a reporting gap into a failed upload — and the values come
    back through the JS boundary, where an absent field is not a Python `None`.
    """

    try:
        size = int(getattr(stored, "size", 0) or 0)
    except (TypeError, ValueError):
        return 0
    return max(size, 0)


async def verify_encode(bucket, asset_id: str, encode_version: int) -> dict:
    """Check that everything the playlists refer to is actually there.

    Nothing is taken on trust, because the ladder arrives by whatever means the
    admin used to upload it. A sync that dropped one file out of a few hundred
    is an ordinary occurrence, and the video plays perfectly until it reaches
    that file — which is the worst possible time to find out.

    Returns what is missing rather than the first thing missing: an admin
    re-running one sync is a better afternoon than an admin re-running six.

    Also adds up what the encode occupies while it is here. R2 reports a size on
    every object this already asks about, so the total is free — whereas getting
    it later means listing a few hundred keys per asset, which is what the
    storage overview must not do on every page view.
    """

    prefix = encode_prefix(asset_id, encode_version)
    missing: list[str] = []
    checked = 0
    total = 0
    # Which objects have already been counted. The playlists are files the tool
    # wrote, so a name can appear twice in them — and counting one object twice
    # inflates a byte total that is now stored and summed, rather than a number
    # nobody read.
    counted: set[str] = set()

    def count(relative: str, stored) -> None:
        nonlocal checked, total
        if relative in counted:
            return
        counted.add(relative)
        checked += 1
        total += _object_bytes(stored)

    # Looked for rather than followed: no playlist refers to the poster, so
    # walking the manifest never reaches it. Its absence does not fail the import
    # — a video with no thumbnail plays — but whether it is there decides what
    # gets recorded, and for a while nothing looked and every import recorded
    # `poster_key` as NULL.
    poster = await bucket.head(poster_key(asset_id, encode_version))
    has_poster = poster is not None
    if has_poster:
        count("poster.webp", poster)

    master = await bucket.get(f"{prefix}master.m3u8")
    if master is None:
        return {"ok": False, "missing": ["master.m3u8"], "objectCount": 0, "byteSize": 0}
    count("master.m3u8", master)

    for rendition in renditions_in(await master.text()):
        if not _safe_relative(rendition):
            missing.append(rendition)
            continue
        if rendition in counted:
            # Named twice in the master. `count` would refuse to count it twice
            # anyway; this is about the round trips — walking it again asks R2
            # for every one of its segments a second time, and the file saying
            # so was uploaded rather than written here. A master naming one
            # rendition a thousand times would otherwise be a thousand walks.
            continue
        playlist = await bucket.get(f"{prefix}{rendition}")
        if playlist is None:
            missing.append(rendition)
            continue
        count(rendition, playlist)

        folder = rendition.rsplit("/", 1)[0] if "/" in rendition else ""
        for segment in segments_in(await playlist.text()):
            if not _safe_relative(segment):
                missing.append(segment)
                continue
            relative = f"{folder}/{segment}" if folder else segment
            if relative in counted:
                # Same reason as above: the count is safe either way, the HEAD
                # request is what this avoids.
                continue
            stored = await bucket.head(f"{prefix}{relative}")
            if stored is None:
                missing.append(relative)
                continue
            count(relative, stored)

    return {
        "ok": not missing,
        "missing": missing,
        "objectCount": checked,
        "byteSize": total,
        "hasPoster": has_poster,
    }


async def create_asset(
    env,
    *,
    title: str,
    original_filename: str,
    byte_size: int,
    duration_seconds: int | None,
    width: int | None,
    height: int | None,
    upload_version: int = 1,
) -> str:
    """An asset for something that has not been uploaded yet.

    The row comes first because every presigned URL is scoped to an asset and a
    version, so there has to be an asset to scope one to. It starts at
    `uploading`, and the only thing that can move it to `ready` is the import
    route, after it has confirmed every object exists.

    The dimensions come from the tool's ffprobe and are for display. Nothing
    about whether the encode is playable is decided from them.
    """

    asset_id = urlsafe_token(18)
    now = utc_timestamp()
    await env.DB.prepare(
        "INSERT INTO video_assets (id, title, original_filename, source_key, status, byte_size,"
        " duration_seconds, width, height, active_encode_version, master_key, poster_key,"
        " error_code, error_detail, created_at, updated_at)"
        " VALUES (?1, ?2, ?3, ?4, 'uploading', ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, NULL, ?9, ?9)"
    ).bind(
        asset_id,
        title,
        original_filename,
        # Derived from the id, never from the filename. `../../` in a filename
        # is a real thing people send.
        source_key(asset_id, upload_version),
        validate_byte_size(byte_size),
        duration_seconds,
        width,
        height,
        now,
    ).run()
    return asset_id


# What `import` finishes with, and an upsert rather than an insert.
#
# The tool creates the asset first — that is what gives it an id to sign upload
# URLs for — and then imports the same id, so the row already exists by the time
# this runs. A plain INSERT was a primary key collision: a 500 on the last step of
# an upload whose objects were all already in R2, which is the most expensive
# place to fail. It is also what makes a re-import after a dropped object
# idempotent instead of a second row.
#
# `byte_size` and `source_key` are deliberately absent from the update. `create`
# knows the source's size and import does not send one, so listing it here would
# overwrite a real number with zero.
REGISTER_SQL = (
    "INSERT INTO video_assets (id, title, original_filename, source_key, status, byte_size,"
    " duration_seconds, width, height, active_encode_version, master_key, poster_key,"
    " error_code, error_detail, created_at, updated_at)"
    " VALUES (?1, ?2, ?3, '', 'ready', 0, ?4, ?5, ?6, ?7, ?8, ?10, NULL, NULL, ?9, ?9)"
    " ON CONFLICT(id) DO UPDATE SET"
    " title = excluded.title,"
    " original_filename = CASE WHEN excluded.original_filename != ''"
    " THEN excluded.original_filename ELSE video_assets.original_filename END,"
    " status = 'ready',"
    " duration_seconds = COALESCE(excluded.duration_seconds, video_assets.duration_seconds),"
    " width = COALESCE(excluded.width, video_assets.width),"
    " height = COALESCE(excluded.height, video_assets.height),"
    " active_encode_version = excluded.active_encode_version,"
    " master_key = excluded.master_key,"
    # Not overwritten with NULL. A re-import of an encode whose poster went
    # missing should not erase the one already recorded.
    " poster_key = COALESCE(excluded.poster_key, video_assets.poster_key),"
    # A previously failed attempt has an error recorded against it, and this row
    # is now a working video.
    " error_code = NULL,"
    " error_detail = NULL,"
    " updated_at = excluded.updated_at"
)


async def register_verified_asset(
    env,
    *,
    asset_id: str,
    title: str,
    original_filename: str,
    duration_seconds: int | None,
    width: int | None,
    height: int | None,
    encode_version: int,
    poster: str | None = None,
) -> str:
    """Record a ladder that was transcoded and uploaded elsewhere.

    Written straight to `ready`, which is the one place the state machine is
    bypassed — and only after `verify_encode` has confirmed every object the
    playlists refer to actually exists. There was no upload session and no
    transcode job for this asset, so there is no earlier state to come from.
    """

    now = utc_timestamp()
    await env.DB.prepare(REGISTER_SQL).bind(
        asset_id,
        title,
        original_filename,
        duration_seconds,
        width,
        height,
        encode_version,
        master_key(asset_id, encode_version),
        now,
        poster,
    ).run()
    return asset_id


# One row per verified output version, and an upsert for the same reason
# `REGISTER_SQL` is one: re-importing after a dropped object is the ordinary
# path, and two rows for one version would each claim its bytes in a total that
# is a SUM over this table.
#
# `created_at` is absent from the update. It says when this encode first
# appeared, which is what the orphan age threshold and the rollback window are
# measured from; `verified_at` is the one that moves.
#
# The three measurements *are* overwritten, deliberately, and this is the
# opposite of what `REGISTER_SQL` does with `poster_key` — worth saying why the
# two differ. `poster_key` is a claim that survives its evidence: a thumbnail
# recorded once still displays, so losing it to one unlucky HEAD is a regression
# for nothing. These columns are a measurement of what is in the bucket right
# now. A measurement that only ever moves upwards is not a measurement, and the
# storage page exists to tell somebody what is actually there.
RECORD_ENCODE_VERSION_SQL = (
    "INSERT INTO video_encode_versions (asset_id, encode_version, object_count, byte_size,"
    " has_poster, verified_at, created_at, updated_at)"
    " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)"
    " ON CONFLICT(asset_id, encode_version) DO UPDATE SET"
    " object_count = excluded.object_count,"
    " byte_size = excluded.byte_size,"
    " has_poster = excluded.has_poster,"
    " verified_at = excluded.verified_at,"
    " updated_at = excluded.updated_at"
)


async def record_encode_version(
    env,
    *,
    asset_id: str,
    encode_version: int,
    object_count: int,
    byte_size: int,
    has_poster: bool,
) -> None:
    """Note that this version exists, and what it holds.

    Written only for a version that verified. The row is the claim "this encode
    is complete", and it is also what tells an orphan scan that the objects
    under this prefix belong to something — writing one for a half-uploaded
    ladder would hide it from the scan while it was still broken.
    """

    now = utc_timestamp()
    await env.DB.prepare(RECORD_ENCODE_VERSION_SQL).bind(
        _asset_id(asset_id),
        _version(encode_version),
        max(int(object_count), 0),
        max(int(byte_size), 0),
        1 if has_poster else 0,
        now,
    ).run()
