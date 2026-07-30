"""Request context, CORS and response helpers for the JSON API."""

import json

from workers import Response

from shared.common import CACHE_1H, env_var
from js import Uint8Array


SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
APP_HEADER = "x-luma-app"

# What a browser may send us cross-origin. `Authorization` is deliberately
# absent, and `has_csrf_protection` depends on that: adding it here would make
# the bearer-token exemption below reachable from a web page.
ALLOWED_REQUEST_HEADERS = "content-type, x-luma-app"


def allowed_origins(env) -> list[str]:
    raw = env_var(env, "ALLOWED_ORIGINS")
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


def frontend_origin(env) -> str:
    """The browser-facing origin used for legacy redirects and OAuth returns."""

    explicit = env_var(env, "FRONTEND_ORIGIN").rstrip("/")
    if explicit:
        return explicit
    origins = allowed_origins(env)
    return origins[0] if origins else ""


class Ctx:
    """Everything a handler needs about one request, plus response builders."""

    def __init__(self, env, request, path: str, query: dict):
        self.env = env
        self.request = request
        self.path = path
        self.query = query
        self.raw_method = str(request.method).upper()
        # Link previewers (LINE, Slack) probe shared URLs with HEAD before a
        # person opens them. Routing on GET alone answered those with a 404,
        # which reads as a dead link, so HEAD takes the GET path throughout.
        self.method = "GET" if self.raw_method == "HEAD" else self.raw_method
        self.origin = (request.headers.get("Origin") or "").rstrip("/")
        self.allowed_origins = allowed_origins(env)
        self.cors = self._cors_headers()

    def _cors_headers(self) -> dict:
        headers = {"vary": "Origin"}
        if self.origin and self.origin in self.allowed_origins:
            headers["access-control-allow-origin"] = self.origin
            headers["access-control-allow-credentials"] = "true"
        return headers

    def origin_allowed(self) -> bool:
        return bool(self.origin) and self.origin in self.allowed_origins

    def carries_bearer_token(self) -> bool:
        """Whether the caller authenticated itself rather than relying on a cookie.

        The distinction is what makes the exemption below safe. Cross-site
        request forgery works because a browser attaches a cookie on its own; it
        cannot attach an `Authorization` header. Setting one makes the request
        preflighted, and `ALLOWED_REQUEST_HEADERS` does not advertise it — so a
        web page cannot reach us this way at all, and the header is proof the
        caller meant to send it.
        """

        return (self.request.headers.get("Authorization") or "").startswith("Bearer ")

    def has_csrf_protection(self) -> bool:
        """Reject cross-site writes that a plain HTML form could forge.

        The frontend is a different origin from this API even though they
        share a site, so requests between them are cross-origin and need this
        on top of the cookie's SameSite=Lax: the custom header forces a
        preflight, which a cross-site form cannot send, and the Origin has to
        be one we published.

        A bearer token is exempt, and it is not a hole — see
        `carries_bearer_token`. Without it the desktop tool, which is not a
        browser and has no origin it could honestly claim, is refused with
        "Cross-site request rejected" before anything looks at its token. The
        alternative would be teaching it to send an Origin it does not have,
        which weakens the check for every real browser to accommodate one client
        the check was never about.
        """

        if self.method in SAFE_METHODS:
            return True
        if self.carries_bearer_token():
            return True
        return self.request.headers.get(APP_HEADER) == "1" and self.origin_allowed()

    async def json_body(self) -> dict:
        body = await self.request.json()
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        return body

    def _headers(self, headers: dict, extra: dict | None) -> dict:
        merged = dict(self.cors)
        merged.update(headers)
        if extra:
            merged.update(extra)
        return merged

    def json(self, body: dict, status: int = 200, extra_headers: dict | None = None) -> Response:
        headers = self._headers({"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}, extra_headers)
        return Response(json.dumps(body, ensure_ascii=False), status=status, headers=headers)

    def error(self, message: str, status: int = 400, extra: dict | None = None) -> Response:
        body = {"error": message}
        if extra:
            body.update(extra)
        return self.json(body, status)

    def redirect(self, location: str, extra_headers: dict | None = None) -> Response:
        headers = self._headers({"location": location, "cache-control": "no-store"}, extra_headers)
        return Response("", status=302, headers=headers)

    def binary(self, content: bytes, headers: dict) -> Response:
        return Response(content, headers=self._headers(headers, None))

    def too_many_requests(self, retry_after: int = 60) -> Response:
        return self.json(
            {"error": "Too many requests, please try again shortly"},
            429,
            {"retry-after": str(retry_after)},
        )

    def preflight(self) -> Response:
        headers = self._headers(
            {
                "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
                "access-control-max-age": "86400",
                "cache-control": "no-store",
            },
            None,
        )
        return Response("", status=204, headers=headers)


async def serve_r2_object(ctx: Ctx, bucket, key: str, content_types: dict, cache: str = CACHE_1H):
    """Read an object and produce the standard public response for it.

    Named for objects rather than images because it also serves the FFmpeg mirror,
    which is a zip. The default content type was already `application/octet-stream`
    — what a caller with no suffix in `content_types` gets — so nothing about the
    behaviour changed with the name.
    """

    obj = await bucket.get(key)
    if obj is None:
        return ctx.error("Image not found", 404)
    suffix = key[key.rfind(".") :].lower()
    body = bytes(Uint8Array.new(await obj.arrayBuffer()).to_py())
    return ctx.binary(
        body,
        {
            "content-type": content_types.get(suffix, "application/octet-stream"),
            "cache-control": cache,
            "x-content-type-options": "nosniff",
        },
    )
