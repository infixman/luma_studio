"""Public ibon collection-code page rendered by the Worker."""

from html import escape


def render_print_page(result: dict) -> str:
    """Render a browser-facing collection page from a cached/upload result."""

    raw_pincode = str(result["pincode"])
    pincode = escape(raw_pincode)
    pincode_digits = "".join(f'<span aria-hidden="true">{escape(digit)}</span>' for digit in raw_pincode)
    deadline = escape(str(result["deadline"]))
    print_specification = escape(str(result.get("printSpec") or "未預選規格"))
    file_count = len(result.get("files") or [])
    qr_code_svg = result["qrCodeSvg"]

    return f"""<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no, date=no, email=no, address=no, url=no">
  <meta name="robots" content="noindex, nofollow">
  <title>ibon 取件編號 | Luma Studio</title>
  <style>
    :root {{ color-scheme:light; font-family:"Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; color:#172c3c; background:#f5f3ed; }}
    * {{ box-sizing:border-box; }}
    body {{ min-height:100vh; margin:0; background:radial-gradient(circle at 12% 8%, #e4eee9 0, transparent 28rem), #f5f3ed; }}
    main {{ width:min(100% - 32px, 680px); margin:0 auto; padding:clamp(30px, 8vh, 72px) 0 44px; }}
    .brand {{ display:flex; justify-content:center; margin:0 auto clamp(30px, 7vh, 56px); }}
    .brand img {{ display:block; width:min(210px, 55vw); height:auto; }}
    .panel {{ overflow:hidden; background:#fffefa; border:1px solid #d8ded7; box-shadow:0 18px 48px rgba(24, 48, 52, .09); }}
    .heading {{ padding:clamp(28px, 7vw, 46px) clamp(24px, 7vw, 56px) 20px; text-align:center; }}
    .eyebrow {{ margin:0 0 10px; color:#2c817b; font-size:.82rem; font-weight:800; letter-spacing:.12em; }}
    h1 {{ margin:0; color:#193345; font-size:clamp(1.6rem, 5vw, 2.25rem); letter-spacing:-.04em; }}
    .subheading {{ margin:12px 0 0; color:#61717a; line-height:1.65; }}
    .qr-wrap {{ display:grid; place-items:center; padding:14px 28px 10px; }}
    .qr {{ display:grid; place-items:center; width:min(100%, 290px); padding:16px; background:#fff; border:1px solid #d9ddd6; }}
    .qr svg {{ display:block; width:100%; height:auto; }}
    .code-block {{ margin:18px clamp(24px, 7vw, 56px) 0; padding:20px; border-top:1px solid #dce2db; border-bottom:1px solid #dce2db; text-align:center; }}
    .code-label {{ display:block; color:#687780; font-size:.85rem; font-weight:700; letter-spacing:.08em; }}
    .pincode {{ display:block; margin:7px 0 0; color:#b9925d; font-size:clamp(2rem, 9vw, 3.15rem); font-weight:800; letter-spacing:.08em; line-height:1.1; text-decoration:none; -webkit-text-decoration:none; }}
    .pincode > span {{ display:inline-block; }} .pincode a {{ color:inherit !important; text-decoration:none !important; -webkit-text-decoration:none !important; pointer-events:none; }}
    .deadline {{ margin:16px 0 0; color:#4f626d; font-size:.95rem; line-height:1.65; }}
    .deadline strong {{ display:block; color:#223d4c; }}
    .specification {{ margin:22px clamp(24px, 7vw, 56px) 0; color:#51636c; text-align:center; line-height:1.7; }} .specification strong {{ display:block; color:#223d4c; }} .specification p {{ margin:4px 0 0; }}
    .actions {{ display:flex; justify-content:center; padding:24px clamp(24px, 7vw, 56px) clamp(30px, 7vw, 46px); }}
    button {{ min-height:44px; border:1px solid #247e78; border-radius:6px; padding:10px 16px; color:#fff; background:#287f79; font:inherit; font-weight:700; cursor:pointer; }}
    button:hover {{ background:#1f6e69; }} button:focus-visible {{ outline:3px solid #a7d5d0; outline-offset:3px; }}
    #copy-status {{ min-height:1.4em; margin:12px 0 0; color:#2c817b; text-align:center; font-size:.9rem; }}
    .footnote {{ margin:26px auto 0; color:#70808a; font-size:.86rem; line-height:1.65; text-align:center; }}
    @media (max-width:420px) {{ main {{ width:min(100% - 24px, 680px); }} .qr-wrap {{ padding-inline:18px; }} .pincode {{ letter-spacing:.04em; }} }}
  </style>
</head>
<body>
  <main>
    <div class="brand"><img src="/assets/luma-studio-logo.png" alt="Luma Studio 南光繪誌"></div>
    <section class="panel" aria-labelledby="title">
      <div class="heading"><p class="eyebrow">IBON CLOUD PRINT</p><h1 id="title">掃描 QR Code 取件</h1><p class="subheading">請在列印期限內前往 ibon 機台，掃描 QR Code 或輸入取件編號。</p></div>
      <div class="qr-wrap"><div class="qr" aria-label="ibon 取件 QR Code">{qr_code_svg}</div></div>
      <div class="code-block"><span class="code-label">取件編號</span><strong id="pincode" class="pincode" data-pincode="{pincode}" aria-label="取件編號 {pincode}">{pincode_digits}</strong><p class="deadline"><strong>文件列印期限</strong>{deadline}</p></div>
      <div class="specification"><strong>列印規格</strong><p>{print_specification}</p></div>
      <div class="actions"><div><button type="button" id="copy">複製取件編號</button><p id="copy-status" aria-live="polite"></p></div></div>
    </section>
    <p class="footnote">本次共 {file_count} 個圖檔。取件編號僅在 ibon 列印期限內有效。</p>
  </main>
  <script>
    document.querySelector('#copy').addEventListener('click', async () => {{
      const code = document.querySelector('#pincode').dataset.pincode;
      const status = document.querySelector('#copy-status');
      try {{
        await navigator.clipboard.writeText(code);
        status.textContent = '已複製取件編號。';
      }} catch {{
        status.textContent = '請手動複製取件編號。';
      }}
    }});
  </script>
</body>
</html>"""
