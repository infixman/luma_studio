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
    assert sanitize_html('<img src="https://example.com/pic.jpg" onerror="alert(1)">text') == '<img src="https://example.com/pic.jpg">text'


def test_img_strips_unsafe_src():
    assert sanitize_html('<img src="javascript:alert(1)">text') == "<img>text"


def test_iframe_allows_youtube():
    raw = '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>'
    assert sanitize_html(raw) == '<iframe src="https://www.youtube.com/embed/abc123" allowfullscreen></iframe>'


def test_iframe_strips_unknown_host():
    assert sanitize_html('<iframe src="https://evil.com/x"></iframe>') == "<iframe></iframe>"


def test_allows_safe_href():
    raw = '<a href="https://example.com">link</a>'
    assert sanitize_html(raw) == '<a href="https://example.com">link</a>'


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
    raw = '<a href="https://example.com" rel="noopener">link</a>'
    assert sanitize_html(raw) == raw


def test_mixed_xss_payload():
    raw = '<p>ok</p><img src=x onerror=alert(1)><script>document.cookie</script><a href="javascript:void(0)">bad</a>'
    result = sanitize_html(raw)
    assert "alert" not in result
    assert "onerror" not in result
    assert "document.cookie" not in result
    assert "javascript:" not in result
    assert "<p>ok</p>" in result
