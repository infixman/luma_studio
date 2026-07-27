"""Shared constants and small helpers used across the Worker's modules."""

import base64
import re
import string
from datetime import datetime, timedelta, timezone

from js import Object, Uint8Array, crypto
from pyodide.ffi import to_js


IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
FILE_NAME_PATTERN = re.compile(r"^[^/\\\x00]{1,180}$")
SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{20,200}")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".gif"}
IMAGE_CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
}
MAX_FILE_COUNT = 8
MAX_TOTAL_BYTES = 15 * 1024 * 1024
CACHE_TTL_SECONDS = 24 * 60 * 60
OAUTH_STATE_TTL_SECONDS = 10 * 60
SESSION_TTL_SECONDS = 12 * 60 * 60
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


def validate_folder(folder: str) -> str:
    if not IDENTIFIER_PATTERN.fullmatch(folder):
        raise ValueError("Folder id must use letters, numbers, _ or -")
    return folder


def validate_file_name(file_name: str) -> str:
    if not FILE_NAME_PATTERN.fullmatch(file_name) or not any(file_name.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES):
        raise ValueError("Only jpg, jpeg, png, bmp or gif image names are allowed")
    return file_name
