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
    # ibon pincode QR codes use a 29×29 viewBox. Retain a two-module quiet
    # zone in the browser while removing presentation-only whitespace.
    qr_code_svg = result["qrCodeSvg"].replace('viewBox="0 0 29 29"', 'viewBox="2 2 25 25"')

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
    main {{ width:min(100% - 32px, 680px); margin:0 auto; padding:clamp(14px, 4vh, 34px) 0 44px; }}
    .brand {{ display:flex; justify-content:center; margin:0 auto 14px; }}
    .brand img {{ display:block; width:min(176px, 48vw); height:auto; }}
    .panel {{ overflow:hidden; background:#fffefa; border:1px solid #d8ded7; box-shadow:0 18px 48px rgba(24, 48, 52, .09); }}
    .qr-wrap {{ display:grid; place-items:center; padding:14px clamp(18px, 5vw, 36px) 0; }}
    .qr {{ display:grid; place-items:center; width:min(100%, 272px); background:#fff; }}
    .qr svg {{ display:block; width:100%; height:auto; }}
    .code-block {{ margin:0; padding:12px clamp(24px, 7vw, 56px) 0; text-align:center; }}
    .code-label {{ display:block; color:#687780; font-size:.85rem; font-weight:700; letter-spacing:.08em; }}
    .pincode {{ display:block; margin:7px 0 0; color:#b9925d; font-size:clamp(2rem, 9vw, 3.15rem); font-weight:800; letter-spacing:.08em; line-height:1.1; text-decoration:none; -webkit-text-decoration:none; }}
    .pincode > span {{ display:inline-block; }} .pincode a {{ color:inherit !important; text-decoration:none !important; -webkit-text-decoration:none !important; pointer-events:none; }}
    .details {{ display:grid; gap:5px; margin:14px 0 0; color:#51636c; font-size:.95rem; line-height:1.65; }} .details p {{ margin:0; }} .details strong {{ color:#223d4c; }}
    .actions {{ display:flex; justify-content:center; padding:18px clamp(24px, 7vw, 56px) 28px; }}
    button {{ min-height:44px; border:1px solid #247e78; border-radius:6px; padding:10px 16px; color:#fff; background:#287f79; font:inherit; font-weight:700; cursor:pointer; }}
    button:hover {{ background:#1f6e69; }} button:focus-visible {{ outline:3px solid #a7d5d0; outline-offset:3px; }}
    #copy-status {{ min-height:1.4em; margin:12px 0 0; color:#2c817b; text-align:center; font-size:.9rem; }}
    .tutorial {{ margin:0 clamp(12px, 4vw, 28px) 20px; padding:28px clamp(20px, 6vw, 44px) clamp(30px, 7vw, 46px); background:#f3f6f2; }}
    .tutorial h2 {{ margin:0; color:#223d4c; font-size:1.25rem; text-align:center; }} .tutorial > p {{ margin:8px 0 22px; color:#687780; text-align:center; line-height:1.6; }}
    .tutorial-list {{ display:grid; gap:24px; margin:0; padding:0; list-style:none; counter-reset:steps; }} .tutorial-list li {{ counter-increment:steps; }}
    .tutorial-step {{ display:flex; align-items:flex-start; gap:11px; color:#40545f; font-weight:700; line-height:1.6; }} .tutorial-step::before {{ display:grid; flex:0 0 26px; width:26px; height:26px; place-items:center; margin-top:1px; border-radius:50%; background:#e4eee9; color:#226f69; content:counter(steps); font-size:.86rem; }}
    .tutorial-image {{ display:block; width:100%; margin:12px 0 0; border:1px solid #d8ded7; }}
    @media (max-width:420px) {{ main {{ width:min(100% - 24px, 680px); }} .qr-wrap {{ padding-inline:14px; }} .pincode {{ letter-spacing:.04em; }} .tutorial {{ padding-inline:18px; }} }}
  </style>
</head>
<body>
  <main>
    <div class="brand"><img src="/assets/luma-studio-logo.png" alt="Luma Studio 南光繪誌"></div>
    <section class="panel" aria-label="ibon 取件資訊">
      <div class="qr-wrap"><div class="qr" aria-label="ibon 取件 QR Code">{qr_code_svg}</div></div>
      <div class="code-block"><span class="code-label">取件編號</span><strong id="pincode" class="pincode" data-pincode="{pincode}" aria-label="取件編號 {pincode}">{pincode_digits}</strong><div class="details"><p><strong>列印期限：</strong>{deadline}</p><p><strong>列印規格：</strong>{print_specification}</p><p><strong>圖檔數量：</strong>{file_count} 個</p></div></div>
      <div class="actions"><div><button type="button" id="copy">複製取件編號</button><p id="copy-status" aria-live="polite"></p></div></div>
      <section class="tutorial" aria-labelledby="tutorial-title"><h2 id="tutorial-title">列印教學</h2><p>前往 7-ELEVEN 的 ibon 機台，依序完成以下步驟。</p><ol class="tutorial-list"><li><div class="tutorial-step">前往 7-ELEVEN 的 ibon 機台。</div></li><li><div class="tutorial-step">在首頁選擇「列印／掃描」，再點選「取件編號列印」。</div><img class="tutorial-image" src="/assets/ibon_step2.png" alt="ibon 首頁的列印掃描選單，取件編號列印已標示"></li><li><div class="tutorial-step">選擇「條碼辨識輸入」，掃描本頁 QR Code 後選擇列印。</div><img class="tutorial-image" src="/assets/ibon_step3.png" alt="ibon 的條碼辨識輸入按鈕已標示"></li></ol></section>
    </section>
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
