"""Play a lesson from the command line, to see what the browser cannot say.

The preview in the back office is a token, a manifest and a few dozen segment
requests. When one of those hangs, the browser shows a black rectangle and the
Worker log shows a request that was cancelled for never answering — and neither
says which request it was.

This does the same sequence with a stopwatch on every step, so the one that
stalls names itself.

    LUMA_ADMIN_COOKIE="luma_admin_session=..." python scripts/preview-probe.py 夜光海浪

The cookie is the admin session, copied from the browser: DevTools →
Application → Cookies → admin-api.luma-studio.tw. It is read from the
environment rather than typed as an argument so it does not end up in a shell
history file.
"""

import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get("LUMA_ADMIN_API", "https://admin-api.luma-studio.tw")
ORIGIN = os.environ.get("LUMA_ADMIN_ORIGIN", "https://admin.luma-studio.tw")
SESSION = os.environ.get("LUMA_ADMIN_COOKIE", "").strip()
WANTED = (sys.argv[1] if len(sys.argv) > 1 else "").strip()

# Long enough that a slow answer is still an answer, short enough that a hang is
# reported rather than waited out.
TIMEOUT = 30

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(path: str, *, method: str = "GET", body: dict | None = None) -> tuple[int, bytes, float]:
    request = urllib.request.Request(
        f"{API}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Origin": ORIGIN,
            "x-luma-app": "1",
            "Cookie": SESSION,
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    started = time.monotonic()
    try:
        with opener.open(request, timeout=TIMEOUT) as answer:
            return answer.status, answer.read(), time.monotonic() - started
    except urllib.error.HTTPError as error:
        return error.code, error.read(), time.monotonic() - started
    except Exception as error:  # a hang lands here, after TIMEOUT
        print(f"  !! {type(error).__name__}: {error}")
        return 0, b"", time.monotonic() - started


def report(label: str, status: int, seconds: float, extra: str = "") -> None:
    mark = "ok " if 200 <= status < 400 else "FAIL"
    print(f"  {mark} {status:>3} {seconds:6.2f}s  {label}{extra}")


def main() -> int:
    if not SESSION:
        print("Set LUMA_ADMIN_COOKIE to the admin session cookie first.")
        return 2

    status, body, seconds = call("/api/video-assets")
    report("list the library", status, seconds)
    if status != 200:
        print(body[:300].decode(errors="replace"))
        return 1

    assets = json.loads(body)["assets"]
    playable = [a for a in assets if a["encodeVersion"] is not None]
    if WANTED:
        playable = [a for a in playable if WANTED in (a["title"] or "")]
    if not playable:
        print(f"nothing playable matching {WANTED!r}")
        return 1
    asset = playable[0]
    print(f"\n{asset['title']}  ({asset['id']}, v{asset['encodeVersion']})")

    status, body, seconds = call(
        f"/api/video-assets/{asset['id']}/playback-preview", method="POST", body={}
    )
    report("mint a playback token", status, seconds)
    if status != 200:
        print(body[:300].decode(errors="replace"))
        return 1
    playback_url = json.loads(body)["playbackUrl"]

    status, body, seconds = call(playback_url)
    report("master.m3u8", status, seconds)
    if status != 200:
        return 1

    prefix = playback_url.rsplit("/", 1)[0]
    rendition = next(
        (line.strip() for line in body.decode().splitlines() if line.strip().endswith(".m3u8")), ""
    )
    if not rendition:
        print("  master names no rendition")
        return 1

    status, body, seconds = call(f"{prefix}/{rendition}")
    report(rendition, status, seconds)
    if status != 200:
        return 1

    folder = rendition.rsplit("/", 1)[0]
    playlist = body.decode().splitlines()
    parts = [line.strip() for line in playlist if line.strip() and not line.startswith("#")]
    init = next(
        (line.split('URI="')[1].split('"')[0] for line in playlist if line.startswith("#EXT-X-MAP")),
        None,
    )

    # The init segment and the first few media segments. These are the ones the
    # gateway puts in the shared cache, which is the newest code on this path
    # and the only part of it a browser exercises dozens of times a lesson.
    for name in ([init] if init else []) + parts[:5]:
        status, _body, seconds = call(f"{prefix}/{folder}/{name}")
        report(f"{folder}/{name}", status, seconds)

    # Again, so a second read of the same objects — the one that answers from
    # the cache rather than from R2 — is timed separately.
    print("\nsecond pass (these should be cache hits):")
    for name in ([init] if init else []) + parts[:5]:
        status, _body, seconds = call(f"{prefix}/{folder}/{name}")
        report(f"{folder}/{name}", status, seconds)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
