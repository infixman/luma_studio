"""Create one ibon guest pincode from this Windows machine.

This is a diagnostic for the ordinary ibon web flow only. It sends GetEntry
and GetPincode, but it never reads or uploads local image files.
"""

import base64
import json
import secrets
import string
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


PRINT_API = "https://print-api.ibon.com.tw/api"
VERSION = "4.2.4"
GUEST_EMAIL = "guest@qware.com.tw"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)


class IbonRequestError(Exception):
    pass


def base64_text(value: str) -> str:
    return base64.b64encode(value.encode("ascii")).decode("ascii")


def random_alpha_numeric(length: int) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def create_disposable_id() -> str:
    """Mirror ibon's bI/_I browser functions exactly."""

    parts = []
    for marker in "xxxxx-xxxxx-4xxxx-yxxxx-xxxxx":
        if marker == "x":
            parts.append(str(secrets.randbelow(10)))
        elif marker == "y":
            parts.append(str((secrets.randbelow(10) & 3) | 8))
        else:
            parts.append(marker)
    uuid = "".join(parts)
    checksum = 0
    for index in (1, 6, 8, 10):
        character = uuid[index]
        checksum += int(character) if character.isdigit() else ord(character) if character.isalpha() else 0
    return f"{uuid}.{checksum}"


def create_entry_bootstrap() -> dict[str, str]:
    """Mirror the browser bundle's disposableId/key/t1 construction."""

    disposable_id = create_disposable_id()
    nonce = random_alpha_numeric(5)
    first_encoding = base64_text(f"{disposable_id}-{nonce}")
    mode = secrets.randbelow(2) + 1
    position = secrets.randbelow(10)
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
        "key": base64_text(mutated),
        "t1": f"{mode}-{position}-{inserted}-{removed}-{nonce}",
    }


def post_json(path: str, payload: dict, extra_headers: dict[str, str] | None = None) -> dict:
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://print.ibon.com.tw",
        "Referer": "https://print.ibon.com.tw/",
        "Accept-Language": "zh-TW,zh;q=0.9",
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Microsoft Edge";v="150"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    }
    if extra_headers:
        headers.update(extra_headers)
    preflight_headers = {
        "Accept": "*/*",
        "Origin": "https://print.ibon.com.tw",
        "Referer": "https://print.ibon.com.tw/",
        "User-Agent": USER_AGENT,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": ",".join(sorted({"content-type", *(key.lower() for key in (extra_headers or {}))})),
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
    }
    try:
        with urlopen(Request(f"{PRINT_API}{path}", headers=preflight_headers, method="OPTIONS"), timeout=20):
            pass
    except (HTTPError, URLError) as error:
        raise IbonRequestError(f"{path} preflight failed: {error}") from error
    request = Request(
        f"{PRINT_API}{path}",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise IbonRequestError(f"{path} HTTP {error.code}: {safe_error_message(body)}") from error
    except URLError as error:
        raise IbonRequestError(f"{path} network error: {error.reason}") from error
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise IbonRequestError(f"{path} returned non-JSON") from error


def safe_error_message(body: str) -> str:
    try:
        parsed = json.loads(body)
        return json.dumps({key: parsed[key] for key in ("code", "msg", "Status", "Message") if key in parsed}, ensure_ascii=False)
    except json.JSONDecodeError:
        return "non-JSON response"


def create_pincode() -> dict:
    bootstrap = create_entry_bootstrap()
    entry = post_json(
        "/BaseEntry/GetEntry",
        {
            "Data": {
                "t2": "1",
                "fV": VERSION,
                "disposableId": bootstrap["disposableId"],
                "memberToken": "",
                "key": bootstrap["key"],
                "t1": bootstrap["t1"],
            }
        },
    )
    result = entry.get("result") or {}
    token, uuid = result.get("token"), result.get("uuid")
    if entry.get("code") != 20000 or not token or not uuid:
        raise IbonRequestError(f"GetEntry failed: {json.dumps({'code': entry.get('code'), 'msg': entry.get('msg')}, ensure_ascii=False)}")

    pincode_response = post_json(
        "/IbonUpload/GetPincode",
        {"Data": {"User": "guest", "Email": GUEST_EMAIL, "SelectType": "FNOMAL"}},
        # The browser sends the disposableId it generated at entry time as the
        # Key header. The current API also returns this as uuid, but use the
        # original value rather than assuming that remains true.
        {"Authorization": token, "FV": VERSION, "Key": bootstrap["disposableId"]},
    )
    pincode_result = pincode_response.get("result") or {}
    if pincode_response.get("code") != 20000 or not pincode_result.get("pincode"):
        raise IbonRequestError(f"GetPincode failed: {json.dumps({'code': pincode_response.get('code'), 'msg': pincode_response.get('msg')}, ensure_ascii=False)}")

    return {
        "pincode": pincode_result["pincode"],
        "deadline": pincode_result.get("deadLine"),
    }


if __name__ == "__main__":
    try:
        print(json.dumps(create_pincode(), ensure_ascii=False, indent=2))
    except IbonRequestError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
