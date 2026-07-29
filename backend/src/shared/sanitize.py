"""Allowlist HTML sanitizer for user-authored rich text.

The WYSIWYG editor sends HTML. Storing it as-is would be stored XSS, so
every save path runs the body through ``sanitize_html`` first.

Safety comes from the allowlist, not from chasing payloads:

  - Only the tags in ``ALLOWED_TAGS`` survive.
  - Only the attributes in ``ALLOWED_ATTRS`` survive, and only on the
    tags they belong to.
  - ``href`` values are checked against ``SAFE_SCHEMES``; a
    ``javascript:`` URI is dropped, not rewritten.
  - Text content inside stripped tags is kept (it becomes escaped text).
    Content inside ``<script>`` and ``<style>`` is dropped entirely.

Built on the standard library's ``html.parser`` so it runs on Cloudflare
Workers without a native extension.
"""

import html
import re
from html.parser import HTMLParser

ALLOWED_TAGS = frozenset(
    {
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "em",
        "u",
        "s",
        "span",
        "a",
        "ul",
        "ol",
        "li",
        "br",
        "hr",
        "blockquote",
        "img",
        "div",
        "iframe",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
    }
)

ALLOWED_ATTRS: dict[str, frozenset[str]] = {
    "a": frozenset({"href", "rel"}),
    "img": frozenset({"src", "alt"}),
    "iframe": frozenset({"src", "allowfullscreen", "style"}),
    "div": frozenset({"style"}),
    "p": frozenset({"style"}),
    "h1": frozenset({"style"}),
    "h2": frozenset({"style"}),
    "h3": frozenset({"style"}),
    "h4": frozenset({"style"}),
    "h5": frozenset({"style"}),
    "h6": frozenset({"style"}),
    "blockquote": frozenset({"style"}),
    "li": frozenset({"style"}),
    "span": frozenset({"style"}),
    "table": frozenset({"style"}),
    "th": frozenset({"style"}),
    "td": frozenset({"style"}),
}

SAFE_IFRAME_HOSTS = frozenset(
    {
        "www.youtube.com",
        "youtube.com",
        "www.instagram.com",
        "instagram.com",
        "www.facebook.com",
        "facebook.com",
    }
)

SAFE_SCHEMES = ("http://", "https://", "mailto:", "/")

SAFE_STYLE_PROPS = frozenset(
    {
        "text-align",
        "position",
        "width",
        "height",
        "padding-bottom",
        "overflow",
        "top",
        "left",
        "border",
        "border-collapse",
        "font-family",
        "font-size",
        "text-decoration",
    }
)


def _sanitize_style(value: str) -> str:
    """Keep only safe CSS properties from a style attribute."""
    parts = []
    for declaration in value.split(";"):
        declaration = declaration.strip()
        if not declaration:
            continue
        if ":" not in declaration:
            continue
        prop, _, val = declaration.partition(":")
        prop = prop.strip().lower()
        val = val.strip()
        if prop in SAFE_STYLE_PROPS and _safe_style_value(prop, val):
            parts.append(f"{prop}:{val}")
    return ";".join(parts)


_LENGTH = re.compile(r"^(?:0|(?:\d{1,3}(?:\.\d{1,2})?)(?:px|rem|em|%))$")
_FONT_FAMILY = re.compile(r"""^[\w\s"',-]+$""")


def _safe_style_value(prop: str, value: str) -> bool:
    lowered = value.lower()
    if "\\" in value or "url(" in lowered or "expression(" in lowered:
        return False
    if prop == "text-align":
        return lowered in {"left", "center", "right", "justify"}
    if prop == "position":
        return lowered in {"relative", "absolute"}
    if prop == "overflow":
        return lowered in {"hidden", "auto", "scroll"}
    if prop in {"width", "height", "padding-bottom", "top", "left", "font-size"}:
        return bool(_LENGTH.fullmatch(lowered))
    if prop == "border":
        return lowered == "0"
    if prop == "border-collapse":
        return lowered in {"collapse", "separate"}
    if prop == "font-family":
        return bool(_FONT_FAMILY.fullmatch(value))
    if prop == "text-decoration":
        return lowered in {"none", "underline", "line-through"}
    return False

OPAQUE_TAGS = frozenset({"script", "style"})

VOID_TAGS = frozenset({"br", "hr", "img"})


def _escape_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.parts: list[str] = []
        self._opaque_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in OPAQUE_TAGS:
            self._opaque_depth += 1
            return
        if self._opaque_depth:
            return
        if tag not in ALLOWED_TAGS:
            return

        allowed = ALLOWED_ATTRS.get(tag, frozenset())
        safe_attrs: list[str] = []
        for name, value in attrs:
            if name not in allowed:
                continue
            if value is None:
                if name == "allowfullscreen":
                    safe_attrs.append(f" {name}")
                continue
            if name in ("href", "src"):
                trimmed = value.strip()
                if not any(trimmed.lower().startswith(s) for s in SAFE_SCHEMES):
                    continue
                if name == "src" and tag == "iframe":
                    from urllib.parse import urlparse
                    host = urlparse(trimmed).hostname or ""
                    if host not in SAFE_IFRAME_HOSTS:
                        continue
                value = trimmed
            if name == "style":
                value = _sanitize_style(value)
                if not value:
                    continue
            safe_attrs.append(f' {name}="{_escape_attr(value)}"')

        if tag in VOID_TAGS:
            self.parts.append(f"<{tag}{''.join(safe_attrs)}>")
        else:
            self.parts.append(f"<{tag}{''.join(safe_attrs)}>")

    def handle_endtag(self, tag: str) -> None:
        if tag in OPAQUE_TAGS:
            self._opaque_depth = max(0, self._opaque_depth - 1)
            return
        if self._opaque_depth:
            return
        if tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self._opaque_depth:
            return
        self.parts.append(html.escape(data))

    def handle_entityref(self, name: str) -> None:
        if self._opaque_depth:
            return
        self.parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._opaque_depth:
            return
        self.parts.append(f"&#{name};")

    def handle_comment(self, _data: str) -> None:
        pass

    def handle_decl(self, _decl: str) -> None:
        pass

    def handle_pi(self, _data: str) -> None:
        pass

    def unknown_decl(self, _data: str) -> None:
        pass


def sanitize_html(raw: str) -> str:
    sanitizer = _Sanitizer()
    sanitizer.feed(raw)
    return "".join(sanitizer.parts)
