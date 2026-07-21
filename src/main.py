"""Cloudflare Python Worker for cached ibon web uploads and R2 administration."""

import base64
import hashlib
import io
import json
import re
import string
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode

import qrcode
import qrcode.image.svg
from admin_html import ADMIN_HTML
from js import Object, Uint8Array, crypto, fetch as js_fetch
from pyodide.ffi import to_js
from workers import Response, WorkerEntrypoint


IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
FILE_NAME_PATTERN = re.compile(r"^[^/\\\x00]{1,180}$")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".gif"}
MAX_FILE_COUNT = 8
MAX_TOTAL_BYTES = 15 * 1024 * 1024
CACHE_TTL_SECONDS = 24 * 60 * 60
OAUTH_STATE_TTL_SECONDS = 10 * 60
SESSION_TTL_SECONDS = 12 * 60 * 60
ALLOWED_ADMIN_EMAILS = frozenset({"chiao7912@gmail.com", "infixman@gmail.com"})


class IbonError(Exception):
    """A safe, request-specific failure from the ordinary ibon web flow."""

    def __init__(self, stage: str, detail: dict):
        self.stage = stage
        self.detail = detail
        super().__init__(f"{stage} failed")


class OAuthError(Exception):
    """Google OAuth failed without exposing OAuth credentials to the user."""


def js_options(value: dict):
    return to_js(value, dict_converter=Object.fromEntries)


def utc_timestamp() -> int:
    return int(datetime.now(timezone.utc).timestamp())


def secure_bytes(length: int) -> bytes:
    values = Uint8Array.new(length)
    crypto.getRandomValues(values)
    return bytes(values.to_py())


def urlsafe_token(length: int = 32) -> str:
    return base64.urlsafe_b64encode(secure_bytes(length)).rstrip(b"=").decode("ascii")


def taipei_upload_time() -> str:
    taipei_now = datetime.now(timezone.utc) + timedelta(hours=8)
    return taipei_now.strftime("%Y%m%d%H%M%S") + f"{taipei_now.microsecond // 1000:03d}"


def random_alpha_numeric(length: int) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(alphabet[value % len(alphabet)] for value in secure_bytes(length))


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


def b64_text(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


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


def ibon_error_detail(response, body: str) -> dict:
    """Keep useful ibon diagnostics without returning tokens or raw bodies."""

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
    response = await js_fetch(url, js_options(options))
    body = await response.text()
    if not response.ok:
        if error_type is IbonError:
            raise IbonError(stage, ibon_error_detail(response, body))
        raise error_type(f"upstream returned HTTP {response.status}")
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        if error_type is IbonError:
            raise IbonError(stage, {"httpStatus": int(response.status), "reason": "nonJsonResponse"}) from error
        raise error_type("upstream returned a non-JSON response") from error


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


async def create_pincode(env, token: str, uuid: str) -> tuple[str, str]:
    payload = {"Data": {"User": "guest", "Email": env.IBON_GUEST_EMAIL, "SelectType": "FNOMAL"}}
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
        raise IbonError("GetChunksize", ibon_error_detail(response, body))
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


def json_response(body: dict, status: int = 200, extra_headers: dict | None = None) -> Response:
    headers = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}
    if extra_headers:
        headers.update(extra_headers)
    return Response(json.dumps(body, ensure_ascii=False), status=status, headers=headers)


def html_response() -> Response:
    return Response(ADMIN_HTML, headers={"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer"})


def redirect(location: str, headers: dict | None = None) -> Response:
    response_headers = {"location": location, "cache-control": "no-store"}
    if headers:
        response_headers.update(headers)
    return Response("", status=302, headers=response_headers)


async def d1_rows(statement) -> list[dict]:
    result = await statement.all()
    return result.results or []


async def invalidate_print_cache(env, identifier: str):
    await env.DB.prepare("DELETE FROM ibon_print_cache WHERE id = ?1").bind(identifier).run()


async def get_cached_result(env, identifier: str) -> dict | None:
    rows = await d1_rows(env.DB.prepare("SELECT pincode, deadline, qr_code_svg, files_json, created_at, cache_expires_at FROM ibon_print_cache WHERE id = ?1 AND cache_expires_at > ?2").bind(identifier, utc_timestamp()))
    if not rows:
        return None
    row = rows[0]
    return {"id": identifier, "pincode": row["pincode"], "deadline": row["deadline"], "qrCodeSvg": row["qr_code_svg"], "files": json.loads(row["files_json"]), "cached": True, "cachedAt": row["created_at"], "cacheExpiresAt": row["cache_expires_at"]}


async def put_cached_result(env, identifier: str, result: dict):
    now, expires = utc_timestamp(), utc_timestamp() + CACHE_TTL_SECONDS
    await env.DB.prepare("""INSERT INTO ibon_print_cache (id, pincode, deadline, qr_code_svg, files_json, created_at, cache_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET pincode = excluded.pincode, deadline = excluded.deadline, qr_code_svg = excluded.qr_code_svg, files_json = excluded.files_json, created_at = excluded.created_at, cache_expires_at = excluded.cache_expires_at""").bind(identifier, result["pincode"], result["deadline"], result["qrCodeSvg"], json.dumps(result["files"]), now, expires).run()
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


def get_cookie(request, name: str) -> str | None:
    cookie_header = request.headers.get("Cookie") or ""
    for item in cookie_header.split(";"):
        key, separator, value = item.strip().partition("=")
        if separator and key == name:
            return value
    return None


def session_cookie(session_id: str, max_age: int) -> str:
    return f"luma_admin_session={session_id}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"


async def get_admin_email(env, request) -> str | None:
    session_id = get_cookie(request, "luma_admin_session")
    if not session_id or not re.fullmatch(r"[A-Za-z0-9_-]{20,200}", session_id):
        return None
    rows = await d1_rows(env.DB.prepare("SELECT email FROM admin_sessions WHERE session_id = ?1 AND expires_at > ?2").bind(session_id, utc_timestamp()))
    return rows[0]["email"] if rows else None


async def begin_google_login(env) -> Response:
    state, verifier = urlsafe_token(), urlsafe_token(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    now = utc_timestamp()
    await env.DB.prepare("DELETE FROM admin_oauth_states WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare("INSERT INTO admin_oauth_states (state, code_verifier, expires_at) VALUES (?1, ?2, ?3)").bind(state, verifier, now + OAUTH_STATE_TTL_SECONDS).run()
    query = urlencode({"client_id": env.GOOGLE_CLIENT_ID, "redirect_uri": env.GOOGLE_OAUTH_REDIRECT_URI, "response_type": "code", "scope": "openid email profile", "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "prompt": "select_account"})
    return redirect(f"https://accounts.google.com/o/oauth2/v2/auth?{query}")


async def complete_google_login(env, query: dict) -> Response:
    state, code = (query.get("state") or [None])[0], (query.get("code") or [None])[0]
    if not state or not code:
        return json_response({"error": "Google login was cancelled or invalid"}, 400)
    rows = await d1_rows(env.DB.prepare("SELECT code_verifier FROM admin_oauth_states WHERE state = ?1 AND expires_at > ?2").bind(state, utc_timestamp()))
    await env.DB.prepare("DELETE FROM admin_oauth_states WHERE state = ?1").bind(state).run()
    if not rows:
        return json_response({"error": "Google login expired; try again"}, 400)
    token_payload = urlencode({"code": code, "client_id": env.GOOGLE_CLIENT_ID, "client_secret": env.GOOGLE_CLIENT_SECRET, "redirect_uri": env.GOOGLE_OAUTH_REDIRECT_URI, "grant_type": "authorization_code", "code_verifier": rows[0]["code_verifier"]})
    token = await fetch_json("https://oauth2.googleapis.com/token", {"method": "POST", "headers": {"content-type": "application/x-www-form-urlencoded"}, "body": token_payload}, OAuthError)
    access_token = token.get("access_token")
    if not access_token:
        raise OAuthError("Google token exchange failed")
    profile = await fetch_json("https://openidconnect.googleapis.com/v1/userinfo", {"headers": {"Authorization": f"Bearer {access_token}"}}, OAuthError)
    email = str(profile.get("email") or "").lower()
    if profile.get("email_verified") is not True or email not in ALLOWED_ADMIN_EMAILS:
        return json_response({"error": "This Google account is not authorized"}, 403)
    session_id, now = urlsafe_token(), utc_timestamp()
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?1").bind(now).run()
    await env.DB.prepare("INSERT INTO admin_sessions (session_id, email, expires_at) VALUES (?1, ?2, ?3)").bind(session_id, email, now + SESSION_TTL_SECONDS).run()
    return redirect("/admin", {"set-cookie": session_cookie(session_id, SESSION_TTL_SECONDS)})


def validate_folder(folder: str) -> str:
    if not IDENTIFIER_PATTERN.fullmatch(folder):
        raise ValueError("Folder id must use letters, numbers, _ or -")
    return folder


def validate_file_name(file_name: str) -> str:
    if not FILE_NAME_PATTERN.fullmatch(file_name) or not any(file_name.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES):
        raise ValueError("Only jpg, jpeg, png, bmp or gif image names are allowed")
    return file_name


async def admin_api(env, request, path: str, query: dict) -> Response:
    if path == "/api/admin/folders" and request.method == "GET":
        listing = await env.IBON_IMAGES.list(delimiter="/", limit=1000)
        folders = sorted(prefix.rstrip("/") for prefix in listing.delimitedPrefixes if IDENTIFIER_PATTERN.fullmatch(prefix.rstrip("/")))
        return json_response({"folders": folders, "truncated": bool(listing.truncated)})

    if path == "/api/admin/folders" and request.method == "POST":
        try:
            folder = validate_folder(str((await request.json()).get("folder") or ""))
        except (ValueError, AttributeError):
            return json_response({"error": "Invalid folder id"}, 400)
        await env.IBON_IMAGES.put(f"{folder}/.keep", "")
        await invalidate_print_cache(env, folder)
        return json_response({"folder": folder}, 201)

    if path.startswith("/api/admin/folders/") and request.method == "DELETE":
        try:
            folder = validate_folder(path.removeprefix("/api/admin/folders/"))
        except ValueError:
            return json_response({"error": "Invalid folder id"}, 400)
        listing = await env.IBON_IMAGES.list(prefix=f"{folder}/", limit=1000)
        if listing.truncated or any(item.key != f"{folder}/.keep" for item in listing.objects):
            return json_response({"error": "Delete the folder's images first"}, 409)
        await env.IBON_IMAGES.delete(f"{folder}/.keep")
        await invalidate_print_cache(env, folder)
        return json_response({"folder": folder, "deleted": True})

    if path == "/api/admin/objects" and request.method == "GET":
        try:
            folder = validate_folder((query.get("folder") or [""])[0])
        except ValueError:
            return json_response({"error": "Invalid folder id"}, 400)
        listing = await env.IBON_IMAGES.list(prefix=f"{folder}/", limit=1000)
        objects = [{"key": item.key, "name": item.key.split("/")[-1], "size": item.size} for item in listing.objects if item.key != f"{folder}/.keep" and any(item.key.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES)]
        return json_response({"folder": folder, "objects": objects, "truncated": bool(listing.truncated)})

    if path == "/api/admin/upload" and request.method == "POST":
        try:
            form = await request.formData()
            folder = validate_folder(str(form.get("folder") or ""))
            uploaded_file = form.get("file")
            file_name = validate_file_name(str(uploaded_file.name))
            if int(uploaded_file.size) <= 0 or int(uploaded_file.size) > MAX_TOTAL_BYTES:
                raise ValueError("Image must be between 1 byte and 15 MB")
        except (ValueError, AttributeError):
            return json_response({"error": "Invalid upload"}, 400)
        existing = await env.IBON_IMAGES.list(prefix=f"{folder}/", limit=1000)
        image_count = sum(any(item.key.lower().endswith(suffix) for suffix in IMAGE_SUFFIXES) for item in existing.objects)
        if existing.truncated or (image_count >= MAX_FILE_COUNT and f"{folder}/{file_name}" not in [item.key for item in existing.objects]):
            return json_response({"error": f"A folder can contain at most {MAX_FILE_COUNT} images"}, 409)
        key = f"{folder}/{file_name}"
        await env.IBON_IMAGES.put(key, uploaded_file)
        await invalidate_print_cache(env, folder)
        return json_response({"key": key}, 201)

    if path == "/api/admin/objects" and request.method == "DELETE":
        key = (query.get("key") or [""])[0]
        folder, separator, file_name = key.partition("/")
        try:
            validate_folder(folder)
            if not separator:
                raise ValueError()
            validate_file_name(file_name)
        except ValueError:
            return json_response({"error": "Invalid object key"}, 400)
        await env.IBON_IMAGES.delete(key)
        await invalidate_print_cache(env, folder)
        return json_response({"key": key, "deleted": True})

    return json_response({"error": "Unknown admin endpoint"}, 404)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        request_url = str(request.url)
        scheme_end = request_url.find("://")
        path_start = request_url.find("/", scheme_end + 3)
        path_and_query = request_url[path_start:] if path_start >= 0 else "/"
        path, _, raw_query = path_and_query.partition("?")
        path = path.rstrip("/") or "/"
        query = parse_qs(raw_query)

        if path == "/auth/login" and request.method == "GET":
            return await begin_google_login(self.env)
        if path == "/auth/callback" and request.method == "GET":
            try:
                return await complete_google_login(self.env, query)
            except OAuthError:
                return json_response({"error": "Google login failed"}, 502)
        if path == "/auth/logout" and request.method == "POST":
            session_id = get_cookie(request, "luma_admin_session")
            if session_id:
                await self.env.DB.prepare("DELETE FROM admin_sessions WHERE session_id = ?1").bind(session_id).run()
            return json_response({"loggedOut": True}, extra_headers={"set-cookie": session_cookie("", 0)})

        if path == "/admin" and request.method == "GET":
            if not await get_admin_email(self.env, request):
                return redirect("/auth/login")
            return html_response()
        if path.startswith("/api/admin/"):
            if not await get_admin_email(self.env, request):
                return json_response({"error": "Authentication required"}, 401)
            return await admin_api(self.env, request, path, query)

        path_parts = path.split("/")
        if len(path_parts) != 3 or path_parts[-2] != "ibon_print":
            return json_response({"error": "Use GET /ibon_print/{id}"}, 404)
        if request.method != "GET":
            return json_response({"error": "Only GET is supported"}, 405)

        identifier = path_parts[-1]
        if not IDENTIFIER_PATTERN.fullmatch(identifier):
            return json_response({"error": "Invalid id"}, 400)
        cached = await get_cached_result(self.env, identifier)
        if cached:
            return json_response(cached)

        try:
            images = await read_images(self.env, identifier)
            token, uuid = await create_web_entry(self.env)
            pincode, deadline = await create_pincode(self.env, token, uuid)
            chunk_size = await get_chunk_size(self.env)
            for index, (file_name, content) in enumerate(images, start=1):
                await upload_file(self.env, pincode, file_name, content, index, len(images), chunk_size)
            result = {"id": identifier, "pincode": pincode, "deadline": deadline, "qrCodeSvg": qr_code_svg(pincode), "files": [file_name for file_name, _ in images], "cached": False}
            await put_cached_result(self.env, identifier, result)
            return json_response(result)
        except ValueError as error:
            return json_response({"error": str(error)}, 400)
        except IbonError as error:
            return json_response({"error": "Ibon upload failed", "stage": error.stage, "detail": error.detail}, 502)
        except Exception:
            return json_response({"error": "Unexpected Worker failure"}, 500)
