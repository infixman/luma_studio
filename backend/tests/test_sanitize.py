import sys, pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))

from shared.sanitize import sanitize_html


def test_allows_safe_tags():
    raw = "<p>Hello <strong>world</strong></p>"
    assert sanitize_html(raw) == raw


def test_strips_script():
    assert sanitize_html("<script>alert('xss')</script>safe") == "safe"


def test_strips_script_content():
    assert sanitize_html("<p>ok</p><script>evil()</script><p>also ok</p>") == "<p>ok</p><p>also ok</p>"


def test_strips_style():
    assert sanitize_html("<style>body{display:none}</style><p>hi</p>") == "<p>hi</p>"


def test_keeps_inline_span_for_authored_text_styles():
    assert sanitize_html("<div><span>hello</span></div>") == "<div><span>hello</span></div>"


def test_img_keeps_safe_src_strips_handlers():
    # The src is one of this site's own asset paths now: an image pointing
    # anywhere else is a request to somebody else's server on every read.
    assert sanitize_html('<img src="/media-assets/pic.jpg" onerror="alert(1)">text') == '<img src="/media-assets/pic.jpg">text'


def test_img_strips_unsafe_src():
    assert sanitize_html('<img src="javascript:alert(1)">text') == "<img>text"


def test_iframe_allows_youtube():
    raw = '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>'
    assert sanitize_html(raw) == '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>'


def test_iframe_strips_unknown_host():
    assert sanitize_html('<iframe src="https://evil.com/x"></iframe>') == "<iframe></iframe>"


def test_allows_safe_href():
    # Outward links carry a safe rel, because a new tab can otherwise reach
    # back into this one.
    raw = '<a href="https://example.com">link</a>'
    assert sanitize_html(raw) == '<a href="https://example.com" rel="noopener noreferrer">link</a>'


def test_allows_mailto_href():
    raw = '<a href="mailto:test@example.com">email</a>'
    assert sanitize_html(raw) == '<a href="mailto:test@example.com">email</a>'


def test_allows_relative_href():
    raw = '<a href="/about">about</a>'
    assert sanitize_html(raw) == '<a href="/about">about</a>'


def test_strips_javascript_href():
    raw = '<a href="javascript:alert(1)">click</a>'
    assert sanitize_html(raw) == "<a>click</a>"


def test_strips_data_href():
    raw = '<a href="data:text/html,<script>alert(1)</script>">click</a>'
    assert sanitize_html(raw) == "<a>click</a>"


def test_strips_event_handlers():
    raw = '<p onclick="alert(1)">text</p>'
    assert sanitize_html(raw) == "<p>text</p>"


def test_escapes_text_content():
    raw = "<p>1 &lt; 2 &amp; 3 &gt; 0</p>"
    result = sanitize_html(raw)
    assert "&lt;" in result
    assert "&amp;" in result


def test_heading_levels():
    raw = "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>"
    assert sanitize_html(raw) == raw


def test_rich_text_styles_survive_without_unsafe_css():
    raw = (
        '<p style="text-align:center;font-family:serif;font-size:24px;'
        'background:url(javascript:evil);position:fixed">Centered</p>'
    )
    assert sanitize_html(raw) == (
        '<p style="text-align:center;font-family:serif;font-size:24px">Centered</p>'
    )


def test_table_and_horizontal_rule():
    raw = (
        '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">'
        "<thead><tr><th>名稱</th><th>數量</th></tr></thead>"
        "<tbody><tr><td>畫紙</td><td>2</td></tr></tbody></table></div><hr>"
    )
    assert sanitize_html(raw) == raw


def test_inline_text_tags():
    raw = "<p><span style=\"font-size:18px\"><u>底線</u>與<s>刪除線</s></span></p>"
    assert sanitize_html(raw) == raw


def test_lists():
    raw = "<ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>"
    assert sanitize_html(raw) == raw


def test_br():
    assert sanitize_html("line1<br>line2") == "line1<br>line2"
    assert sanitize_html("line1<br/>line2") == "line1<br>line2"


def test_blockquote():
    raw = "<blockquote><p>quote</p></blockquote>"
    assert sanitize_html(raw) == raw


def test_nested_script_depth():
    raw = "<script><script>double</script></script>safe"
    result = sanitize_html(raw)
    assert "safe" in result
    assert "double" not in result


def test_empty_string():
    assert sanitize_html("") == ""


def test_plain_text():
    assert sanitize_html("hello world") == "hello world"


def test_strips_rel_on_non_a():
    raw = '<p rel="noopener">text</p>'
    assert sanitize_html(raw) == "<p>text</p>"


def test_allows_rel_on_a():
    # Whatever rel the author wrote, the safe value is the one that ships.
    raw = '<a href="https://example.com" rel="noopener">link</a>'
    assert sanitize_html(raw) == '<a href="https://example.com" rel="noopener noreferrer">link</a>'


def test_mixed_xss_payload():
    raw = '<p>ok</p><img src=x onerror=alert(1)><script>document.cookie</script><a href="javascript:void(0)">bad</a>'
    result = sanitize_html(raw)
    assert "alert" not in result
    assert "onerror" not in result
    assert "document.cookie" not in result
    assert "javascript:" not in result
    assert "<p>ok</p>" in result


class TestImagesComeFromTheLibrary:
    """An image tag is a request to somebody else's server.

    Left open, an author — or anybody who gets content past the editor — can
    point one at a host that logs every reader's address, and the page will
    fetch it faithfully.
    """

    def test_an_image_from_the_media_library_survives(self):
        html = sanitize_html('<p><img src="/media-assets/abc.jpg" alt="圖"></p>')

        assert "/media-assets/abc.jpg" in html

    def test_an_image_from_somewhere_else_is_dropped(self):
        html = sanitize_html('<p><img src="https://tracker.example/pixel.gif" alt=""></p>')

        assert "tracker.example" not in html

    def test_a_protocol_relative_image_is_dropped(self):
        """`//host/x.gif` inherits the page's scheme and is easy to miss."""

        html = sanitize_html('<img src="//tracker.example/pixel.gif" alt="">')

        assert "tracker.example" not in html

    def test_a_shop_asset_is_also_allowed(self):
        html = sanitize_html('<img src="/shop-assets/abc.jpg" alt="">')

        assert "/shop-assets/abc.jpg" in html


class TestExternalLinks:
    def test_a_link_off_site_is_given_a_safe_rel(self):
        """`noopener` because a new tab can otherwise reach back into this one."""

        html = sanitize_html('<a href="https://example.com">看這裡</a>')

        assert 'rel="noopener noreferrer"' in html

    def test_an_authors_own_rel_is_replaced_not_appended_to(self):
        """Whatever they wrote, the safe value is the one that ships."""

        html = sanitize_html('<a href="https://example.com" rel="opener">x</a>')

        assert html.count("rel=") == 1
        assert 'rel="noopener noreferrer"' in html

    def test_a_link_within_the_site_is_left_alone(self):
        """It opens in this tab, and `noreferrer` would hide our own analytics
        from ourselves."""

        html = sanitize_html('<a href="/shop">商城</a>')

        assert "rel=" not in html
