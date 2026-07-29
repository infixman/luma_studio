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
from html.parser import HTMLParser

ALLOWED_TAGS = frozenset(
    {
        "p",
        "h2",
        "h3",
        "h4",
        "strong",
        "em",
        "a",
        "ul",
        "ol",
        "li",
        "br",
        "blockquote",
    }
)

ALLOWED_ATTRS: dict[str, frozenset[str]] = {
    "a": frozenset({"href", "rel"}),
}

SAFE_SCHEMES = ("http://", "https://", "mailto:", "/")

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
                continue
            if name == "href":
                trimmed = value.strip()
                if not any(trimmed.lower().startswith(s) for s in SAFE_SCHEMES):
                    continue
                value = trimmed
            safe_attrs.append(f' {name}="{_escape_attr(value)}"')

        if tag in VOID_TAGS:
            self.parts.append(f"<{tag}>")
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
