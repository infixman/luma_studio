"""Request context, CORS and response helpers for the JSON API."""

import json

from workers import Response

from common import env_var


SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
APP_HEADER = "x-luma-app"
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
        self.method = str(request.method).upper()
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

    def has_csrf_protection(self) -> bool:
        """Reject cross-site writes that a plain HTML form could forge.

        The session cookie must be SameSite=None so the separately deployed
        frontend can authenticate, so the custom header (which forces a
        preflight) and the Origin allowlist carry the CSRF defence instead.
        """

        if self.method in SAFE_METHODS:
            return True
        return self.request.headers.get(APP_HEADER) == "1" and self.origin_allowed()

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

    def preflight(self) -> Response:
        headers = self._headers(
            {
                "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
                "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
                "access-control-max-age": "86400",
                "cache-control": "no-store",
            },
            None,
        )
        return Response("", status=204, headers=headers)
