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

from shared.common import d1_changed, d1_rows, utc_timestamp


MIB = 1024 * 1024

# R2's multipart limits. Both are the service's, not ours.
MIN_PART_SIZE = 5 * MIB
MAX_PARTS = 10_000

# Ours: a course lesson beyond this is a mistake or a misuse, and either way
# the pipeline should say so before the upload rather than during it.
MAX_UPLOAD_BYTES = 20 * 1024 * MIB

ASSET_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,40}$")
OUTPUT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$")
OUTPUT_SUFFIXES = (".m3u8", ".mp4", ".m4s", ".webp")

# The ladder, largest first. Bitrates and keyframe settings belong with the
# encoder; what matters here is the names, because they are in object keys.
RENDITIONS = (("1080p", 1080), ("720p", 720), ("480p", 480))
RENDITION_NAMES = tuple(name for name, _ in RENDITIONS)

STATUSES = ("uploading", "uploaded", "queued", "processing", "ready", "failed", "aborted", "archived")

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


def part_size_for(byte_size: int) -> int:
    """The part size this upload should use.

    Rounded up to whole mebibytes so the client's arithmetic and ours cannot
    disagree at the final part, which is the one place a mismatch costs the
    entire upload.
    """

    if not isinstance(byte_size, int) or isinstance(byte_size, bool) or byte_size <= 0:
        raise ValueError("影片大小必須是正整數")
    if byte_size > MAX_UPLOAD_BYTES:
        raise ValueError(f"單一影片不能超過 {MAX_UPLOAD_BYTES // (1024 * MIB)} GiB")

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


def source_key(asset_id: str, upload_version: int) -> str:
    """Where the original lands.

    Named after the asset, not the file. `../../` in a filename is a real
    thing people send, and a key built from one is a write to somewhere the
    uploader chose.
    """

    return f"sources/{_asset_id(asset_id)}/{_version(upload_version)}/source.mp4"


def master_key(asset_id: str, encode_version: int) -> str:
    return f"videos/{_asset_id(asset_id)}/{_version(encode_version)}/master.m3u8"


def poster_key(asset_id: str, encode_version: int) -> str:
    return f"videos/{_asset_id(asset_id)}/{_version(encode_version)}/poster.webp"


def rendition_key(asset_id: str, encode_version: int, rendition: str, name: str) -> str:
    if rendition not in RENDITION_NAMES:
        raise ValueError(f"Unknown rendition: {rendition}")
    if not isinstance(name, str) or not OUTPUT_NAME_PATTERN.fullmatch(name):
        raise ValueError("Invalid output name")
    if not name.endswith(OUTPUT_SUFFIXES):
        raise ValueError("Invalid output type")
    return f"videos/{_asset_id(asset_id)}/{_version(encode_version)}/{rendition}/{name}"


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
