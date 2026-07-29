"""The ordinary ibon web-upload flow, its D1 cache and print-spec model."""

import base64
import io
import json
import re

import qrcode
import qrcode.image.svg
from js import Uint8Array, fetch as js_fetch

from shared.common import (
    CACHE_TTL_SECONDS,
    DEFAULT_PRINT_SELECT_TYPE,
    IMAGE_SUFFIXES,
    MAX_FILE_COUNT,
    MAX_TOTAL_BYTES,
    PRESET_PRINT_SELECT_TYPES,
    IbonError,
    b64_text,
    d1_rows,
    fetch_json,
    js_options,
    random_alpha_numeric,
    secure_bytes,
    taipei_upload_time,
    upstream_error_detail,
    utc_timestamp,
)


def create_disposable_id() -> str:
    """Mirror ibon's bI/_I browser functions exactly."""

    values = iter(secure_bytes(30))
    parts = []
    for marker in "xxxxx-xxxxx-4xxxx-yxxxx-xxxxx":
        if marker == "x":
            parts.append(str(next(values) % 10))
        elif marker == "y":
            parts.append(str((next(values) % 10 & 3) | 8))
        else:
            parts.append(marker)
    uuid = "".join(parts)
    checksum = 0
    for index in (1, 6, 8, 10):
        character = uuid[index]
        checksum += int(character) if character.isdigit() else ord(character) if character.isalpha() else 0
    return f"{uuid}.{checksum}"


def create_entry_bootstrap() -> dict[str, str]:
    """Generate the ordinary ibon website's disposableId/key/t1 payload."""

    disposable_id = create_disposable_id()
    nonce = random_alpha_numeric(5)
    first_encoding = b64_text(f"{disposable_id}-{nonce}")
    mode = 1 + (secure_bytes(1)[0] % 2)
    position = secure_bytes(1)[0] % 10
    inserted = ""
    removed = ""

    if mode == 1:
        inserted = random_alpha_numeric(1)
        mutated = first_encoding[:position] + inserted + first_encoding[position:]
    else:
        removed = first_encoding[position]
        mutated = first_encoding[:position] + first_encoding[position + 1 :]

    return {
        "disposableId": disposable_id,
        "key": b64_text(mutated),
        "t1": f"{mode}-{position}-{inserted}-{removed}-{nonce}",
    }


def ibon_headers(env, authorization: str | None = None, key: str | None = None) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://print.ibon.com.tw",
        "Referer": "https://print.ibon.com.tw/",
        "Accept-Language": "zh-TW,zh;q=0.9",
    }
    if authorization:
        headers["Authorization"] = authorization
    if key:
        headers["Key"] = key
        headers["FV"] = env.IBON_CLIENT_VERSION
    return headers


async def create_web_entry(env) -> tuple[str, str]:
    bootstrap = create_entry_bootstrap()
    payload = {"Data": {"t2": "1", "fV": env.IBON_CLIENT_VERSION, "disposableId": bootstrap["disposableId"], "memberToken": "", "key": bootstrap["key"], "t1": bootstrap["t1"]}}
    result = await fetch_json(
        f"{env.IBON_PRINT_API_BASE_URL}/BaseEntry/GetEntry",
        {"method": "POST", "headers": ibon_headers(env), "body": json.dumps(payload)},
        stage="GetEntry",
    )
    entry = result.get("result") or {}
    token, uuid = entry.get("token"), entry.get("uuid")
    if result.get("code") != 20000 or not token or not uuid:
        raise IbonError("GetEntry", {"code": result.get("code"), "msg": result.get("msg", "missing token or uuid")})
    # The browser sends its generated disposableId as the Key header. The API
    # currently echoes it as uuid, but retaining the original value is safer.
    return token, bootstrap["disposableId"]


async def create_pincode(env, token: str, uuid: str, select_type: str) -> tuple[str, str]:
    payload = {"Data": {"User": "guest", "Email": env.IBON_GUEST_EMAIL, "SelectType": select_type}}
    result = await fetch_json(
        f"{env.IBON_PRINT_API_BASE_URL}/IbonUpload/GetPincode",
        {"method": "POST", "headers": ibon_headers(env, authorization=token, key=uuid), "body": json.dumps(payload)},
        stage="GetPincode",
    )
    pincode = (result.get("result") or {}).get("pincode")
    deadline = (result.get("result") or {}).get("deadLine")
    if result.get("code") != 20000 or not pincode or not deadline:
        raise IbonError("GetPincode", {"code": result.get("code"), "msg": result.get("msg", "missing pincode or deadline")})
    return pincode, deadline


async def get_chunk_size(env) -> int:
    response = await js_fetch(f"{env.IBON_UPLOAD_API_BASE_URL}/GetChunksize")
    body = await response.text()
    if not response.ok:
        raise IbonError("GetChunksize", upstream_error_detail(response, body))
    try:
        value = int(json.loads(body).get("ChunkSize"))
        if value <= 0:
            raise ValueError()
        return value
    except (AttributeError, json.JSONDecodeError, TypeError, ValueError):
        raise IbonError("GetChunksize", {"httpStatus": int(response.status), "reason": "invalidChunkSize"})


async def upload_file(env, pincode: str, file_name: str, content: bytes, serial: int, total_files: int, chunk_size: int):
    for offset in range(0, len(content), chunk_size):
        chunk = content[offset : offset + chunk_size]
        payload = {
            "ExtParameter": {"useMode": "API", "note1": None, "note2": None, "note3": None, "pincode": pincode, "fileName": file_name, "filesize": str(len(content)), "isMultiFile": total_files > 1, "fileSerial": serial, "uploadTime": taipei_upload_time()},
            "buffer": base64.b64encode(chunk).decode("ascii"),
            "offset": str(offset),
        }
        result = await fetch_json(
            f"{env.IBON_UPLOAD_API_BASE_URL}/Upload",
            {"method": "POST", "headers": ibon_headers(env), "body": json.dumps(payload, separators=(",", ":"))},
            stage="Upload",
        )
        if result.get("Status") not in {"C", "S"}:
            raise IbonError("Upload", {"file": file_name, "offset": offset, "Status": result.get("Status"), "Message": result.get("Message")})


def qr_code_svg(pincode: str) -> str:
    image = qrcode.make(pincode, image_factory=qrcode.image.svg.SvgPathImage)
    output = io.BytesIO()
    image.save(output)
    return output.getvalue().decode("utf-8")


def print_spec(select_type: str) -> str:
    if select_type == "F4X6N1":
        return "4x6、彩色、單面列印、一般用紙"
    if select_type == "F4X6S1":
        return "4x6貼紙、彩色、單面列印、一般用紙"
    match = re.fullmatch(r"F(A[34])(C|B)(N|S)(1|2)", select_type)
    if not match:
        return "未預選規格"
    paper_size, color_mode, paper_kind, sides = match.groups()
    return "、".join((paper_size, "彩色" if color_mode == "C" else "黑白", "單面列印" if sides == "1" else "雙面列印", "一般用紙" if paper_kind == "N" else "特殊用紙"))


def validate_select_type(select_type: str) -> str:
    if select_type not in PRESET_PRINT_SELECT_TYPES:
        raise ValueError("Unsupported print setting")
    return select_type


async def invalidate_print_cache(env, identifier: str):
    await env.DB.prepare("DELETE FROM ibon_print_cache WHERE id = ?1").bind(identifier).run()


async def get_folder_select_type(env, identifier: str) -> str:
    rows = await d1_rows(env.DB.prepare("SELECT select_type FROM folder_print_settings WHERE folder_id = ?1").bind(identifier))
    return rows[0]["select_type"] if rows else DEFAULT_PRINT_SELECT_TYPE


async def get_cached_result(env, identifier: str, select_type: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT pincode, deadline, qr_code_svg, files_json, created_at, cache_expires_at FROM ibon_print_cache WHERE id = ?1 AND select_type = ?2 AND cache_expires_at > ?3").bind(identifier, select_type, utc_timestamp()))
    if not rows:
        return None
    row = rows[0]
    return {"id": identifier, "pincode": row["pincode"], "deadline": row["deadline"], "qrCodeSvg": row["qr_code_svg"], "files": json.loads(row["files_json"]), "selectType": select_type, "printSpec": print_spec(select_type), "cached": True, "cachedAt": row["created_at"], "cacheExpiresAt": row["cache_expires_at"]}


async def put_cached_result(env, identifier: str, result: dict):
    now, expires = utc_timestamp(), utc_timestamp() + CACHE_TTL_SECONDS
    await env.DB.prepare("""INSERT INTO ibon_print_cache (id, pincode, deadline, qr_code_svg, files_json, select_type, created_at, cache_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET pincode = excluded.pincode, deadline = excluded.deadline, qr_code_svg = excluded.qr_code_svg, files_json = excluded.files_json, select_type = excluded.select_type, created_at = excluded.created_at, cache_expires_at = excluded.cache_expires_at""").bind(identifier, result["pincode"], result["deadline"], result["qrCodeSvg"], json.dumps(result["files"]), result["selectType"], now, expires).run()
    result["cachedAt"], result["cacheExpiresAt"] = now, expires


async def read_images(env, identifier: str) -> list[tuple[str, bytes]]:
    listing = await env.IBON_IMAGES.list(prefix=f"{identifier}/")
    if listing.truncated:
        raise ValueError("Too many R2 objects were found for this id")
    image_objects = [item for item in listing.objects if any(item.key.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES)]
    image_objects.sort(key=lambda item: item.key)
    if not image_objects:
        raise ValueError("No supported images were found for this id")
    if len(image_objects) > MAX_FILE_COUNT:
        raise ValueError(f"At most {MAX_FILE_COUNT} images are allowed")
    images, total_bytes = [], 0
    for item in image_objects:
        object_body = await env.IBON_IMAGES.get(item.key)
        if object_body is None:
            raise ValueError(f"R2 object disappeared: {item.key}")
        content = bytes(Uint8Array.new(await object_body.arrayBuffer()).to_py())
        total_bytes += len(content)
        if total_bytes > MAX_TOTAL_BYTES:
            raise ValueError("Images exceed the 15 MB ibon web-upload limit")
        images.append((item.key.split("/")[-1], content))
    return images


async def resolve_print_result(env, identifier: str) -> dict:
    """Return the cached collection code, or run the full ibon upload flow."""

    select_type = await get_folder_select_type(env, identifier)
    cached = await get_cached_result(env, identifier, select_type)
    if cached:
        return cached

    images = await read_images(env, identifier)
    token, uuid = await create_web_entry(env)
    pincode, deadline = await create_pincode(env, token, uuid, select_type)
    chunk_size = await get_chunk_size(env)
    for index, (file_name, content) in enumerate(images, start=1):
        await upload_file(env, pincode, file_name, content, index, len(images), chunk_size)
    result = {
        "id": identifier,
        "pincode": pincode,
        "deadline": deadline,
        "qrCodeSvg": qr_code_svg(pincode),
        "files": [file_name for file_name, _ in images],
        "selectType": select_type,
        "printSpec": print_spec(select_type),
        "cached": False,
    }
    await put_cached_result(env, identifier, result)
    return result
