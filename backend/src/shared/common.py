"""Shared constants and small helpers used across the Worker's modules."""

import base64
import json
import re
import string
from datetime import datetime, timedelta, timezone

from js import Object, Uint8Array, crypto, fetch as js_fetch
from pyodide.ffi import to_js


IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
FILE_NAME_PATTERN = re.compile(r"^[^/\\\x00]{1,180}$")
SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{20,200}")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".gif"}
BASE_IMAGE_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
IMAGE_CONTENT_TYPES = BASE_IMAGE_CONTENT_TYPES | {".bmp": "image/bmp", ".gif": "image/gif"}
MAX_FILE_COUNT = 8
MAX_TOTAL_BYTES = 15 * 1024 * 1024
CACHE_TTL_SECONDS = 24 * 60 * 60
OAUTH_STATE_TTL_SECONDS = 10 * 60
SESSION_TTL_SECONDS = 12 * 60 * 60
CACHE_1H = "public, max-age=3600"
CACHE_1D = "public, max-age=86400"
# For an object only the signed-in admin may see, at a URL that carries the
# encode version. Private because a shared cache holding it would be holding
# something from a bucket that is not public; immutable because a re-encode
# changes the version and therefore the URL.
CACHE_PRIVATE_VERSIONED = "private, max-age=31536000, immutable"
ALLOWED_ADMIN_EMAILS = frozenset({"chiao7912@gmail.com", "infixman@gmail.com"})
DEFAULT_PRINT_SELECT_TYPE = "FA4CN1"
PRESET_PRINT_SELECT_TYPES = frozenset(
    f"F{paper_size}{color_mode}{paper_kind}{sides}"
    for paper_size in ("A4", "A3")
    for color_mode in ("C", "B")
    for paper_kind in ("N", "S")
    for sides in ("1", "2")
) | frozenset({"F4X6N1", "F4X6S1"})


class IbonError(Exception):
    """A safe, request-specific failure from the ordinary ibon web flow."""

    def __init__(self, stage: str, detail: dict):
        self.stage = stage
        self.detail = detail
        super().__init__(f"{stage} failed")


class OAuthError(Exception):
    """Google OAuth failed without exposing OAuth credentials to the user."""


class NotConfigured(Exception):
    """A secret or setting this deployment needs is absent.

    Its own type because it is nobody's fault but ours, and must not be answered
    like a bad request. The alternative — carrying on with an empty credential —
    produces a signature nothing accepts or a derived key anybody can compute,
    and in both cases the failure lands somewhere with no explanation attached.
    """


class MigrationError(Exception):
    """A D1 migration failed, so the request must not touch an unknown schema."""

    def __init__(self, name: str):
        self.name = name
        super().__init__(f"migration {name} failed")


def js_options(value: dict):
    return to_js(value, dict_converter=Object.fromEntries)


def env_var(env, name: str, default: str = "") -> str:
    """Read a wrangler [vars] entry, tolerating deployments that omit it."""

    try:
        value = getattr(env, name)
    except AttributeError:
        return default
    return default if value is None else str(value)


def utc_timestamp() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def secure_bytes(length: int) -> bytes:
    values = Uint8Array.new(length)
    crypto.getRandomValues(values)
    return bytes(values.to_py())


def urlsafe_token(length: int = 32) -> str:
    return base64.urlsafe_b64encode(secure_bytes(length)).rstrip(b"=").decode("ascii")


def taipei_day() -> str:
    """The calendar date in Taipei, used to bucket bio-link analytics."""

    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")


def taipei_upload_time() -> str:
    taipei_now = datetime.now(timezone.utc) + timedelta(hours=8)
    return taipei_now.strftime("%Y%m%d%H%M%S") + f"{taipei_now.microsecond // 1000:03d}"


def random_alpha_numeric(length: int) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(alphabet[value % len(alphabet)] for value in secure_bytes(length))


def b64_text(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


async def d1_rows(statement) -> list[dict]:
    result = await statement.all()
    return result.results or []


def d1_changed(result) -> bool:
    """Whether a D1 write affected exactly one row."""

    try:
        return int(result.meta.changes) == 1
    except (AttributeError, TypeError, ValueError):
        return False


def escape_like(term: str) -> str:
    """Quote SQLite LIKE metacharacters for queries that use ESCAPE '\\'."""

    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def validate_image_suffix(file_name: str, allowed: set[str], error_msg: str) -> str:
    suffix = file_name[file_name.rfind(".") :].lower()
    if "/" in file_name or ".." in file_name or suffix not in allowed:
        raise ValueError(error_msg)
    return suffix


def random_object_key(prefix: str, suffix: str, token_len: int = 12) -> str:
    return f"{prefix}/{urlsafe_token(token_len)}{suffix}"


def storage_key_to_url(key: str | None, storage_prefix: str, url_prefix: str) -> str | None:
    if not key or not key.startswith(f"{storage_prefix}/"):
        return None
    return f"{url_prefix}/{key.removeprefix(f'{storage_prefix}/')}"


def validate_text(value, limit: int, label: str, *, required: bool = True, error_cls=ValueError) -> str:
    value = str(value or "").strip()
    if required and not value:
        raise error_cls(f"{label} is required")
    if len(value) > limit:
        raise error_cls(f"{label} must be {limit} characters or fewer")
    return value


def validate_choice(value, allowed, label: str, *, error_cls=ValueError):
    if value not in allowed:
        raise error_cls(f"{label} must be one of: {', '.join(str(v) for v in allowed)}")
    return value


async def reorder_rows(env, table: str, id_col: str, ordered_ids: list[str], *, timestamp_col: str | None = None) -> None:
    """Rewrite a known table's display positions in the supplied order."""

    now = utc_timestamp() if timestamp_col else None
    for index, row_id in enumerate(ordered_ids):
        if timestamp_col:
            await env.DB.prepare(
                f"UPDATE {table} SET position = ?2, {timestamp_col} = ?3 WHERE {id_col} = ?1"
            ).bind(row_id, index, now).run()
        else:
            await env.DB.prepare(f"UPDATE {table} SET position = ?2 WHERE {id_col} = ?1").bind(row_id, index).run()


async def next_position(env, table: str, where: str = "", bindings: tuple = ()) -> int:
    query = f"SELECT COALESCE(MAX(position), -1) AS last FROM {table}"
    if where:
        query += f" WHERE {where}"
    rows = await d1_rows(env.DB.prepare(query).bind(*bindings))
    return (int(rows[0]["last"]) if rows else -1) + 1


def upstream_error_detail(response, body: str) -> dict:
    detail = {"httpStatus": int(response.status)}
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return detail
    for key in ("code", "msg", "Status", "Message"):
        if key in payload and isinstance(payload[key], (str, int, float, bool)):
            detail[key] = payload[key]
    return detail


async def fetch_json(url: str, options: dict, error_type=IbonError, stage: str = "upstream") -> dict:
    """Fetch and decode JSON without coupling OAuth to the ibon module."""

    response = await js_fetch(url, js_options(options))
    body = await response.text()
    if not response.ok:
        if error_type is IbonError:
            raise IbonError(stage, upstream_error_detail(response, body))
        raise error_type(f"upstream returned HTTP {response.status}")
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        if error_type is IbonError:
            raise IbonError(stage, {"httpStatus": int(response.status), "reason": "nonJsonResponse"}) from error
        raise error_type("upstream returned a non-JSON response") from error


def validate_folder(folder: str) -> str:
    if not IDENTIFIER_PATTERN.fullmatch(folder):
        raise ValueError("Folder id must use letters, numbers, _ or -")
    return folder


def validate_file_name(file_name: str) -> str:
    if not FILE_NAME_PATTERN.fullmatch(file_name) or not any(file_name.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES):
        raise ValueError("Only jpg, jpeg, png, bmp or gif image names are allowed")
    return file_name
