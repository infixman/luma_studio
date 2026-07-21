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
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/assets/luma-studio-favicon.png">
  <link rel="apple-touch-icon" href="/assets/luma-studio-favicon.png">
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
    .tutorial {{ margin:0 clamp(12px, 4vw, 28px) 16px; padding:22px clamp(20px, 6vw, 44px) clamp(30px, 7vw, 46px); background:#f3f6f2; }}
    .tutorial h2 {{ margin:0; color:#223d4c; font-size:1.25rem; text-align:center; }} .tutorial > p {{ margin:8px 0 22px; color:#687780; text-align:center; line-height:1.6; }}
    .tutorial-list {{ display:grid; gap:24px; margin:0; padding:0; list-style:none; counter-reset:steps; }} .tutorial-list li {{ counter-increment:steps; }}
    .tutorial-step {{ display:flex; align-items:flex-start; gap:11px; color:#40545f; font-weight:700; line-height:1.6; }} .tutorial-step::before {{ display:grid; flex:0 0 26px; width:26px; height:26px; place-items:center; margin-top:1px; border-radius:50%; background:#e4eee9; color:#226f69; content:counter(steps); font-size:.86rem; }}
    .tutorial-image {{ display:block; width:100%; margin:12px 0 0; border:1px solid #d8ded7; cursor:zoom-in; }} .tutorial-image:focus-visible {{ outline:3px solid #78aea9; outline-offset:3px; }}
    .lightbox[hidden] {{ display:none; }} .lightbox {{ position:fixed; z-index:20; inset:0; display:grid; place-items:center; padding:clamp(18px, 5vw, 48px); background:rgba(21, 35, 43, .88); cursor:zoom-out; }} .lightbox img {{ display:block; max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 18px 60px rgba(0, 0, 0, .38); }}
    @media (max-width:420px) {{ main {{ width:min(100% - 24px, 680px); }} .qr-wrap {{ padding-inline:14px; }} .pincode {{ letter-spacing:.04em; }} .tutorial {{ padding-inline:18px; }} }}
  </style>
</head>
<body>
  <main>
    <div class="brand"><img src="/assets/luma-studio-logo.png" alt="Luma Studio 南光繪誌"></div>
    <section class="panel" aria-label="ibon 取件資訊">
      <div class="qr-wrap"><div class="qr" aria-label="ibon 取件 QR Code">{qr_code_svg}</div></div>
      <div class="code-block"><span class="code-label">取件編號</span><strong id="pincode" class="pincode" data-pincode="{pincode}" aria-label="取件編號 {pincode}">{pincode_digits}</strong><div class="details"><p><strong>列印期限：</strong>{deadline}</p><p><strong>列印規格：</strong>{print_specification}</p><p><strong>圖檔數量：</strong>{file_count} 個</p></div></div>
      <section class="tutorial" aria-labelledby="tutorial-title"><h2 id="tutorial-title">列印教學</h2><p>前往 7-ELEVEN 的 ibon 機台，依序完成以下步驟。</p><ol class="tutorial-list"><li><div class="tutorial-step">在首頁「列印／掃描」下方點選「取件編號列印」。</div><img class="tutorial-image" src="/assets/ibon_step1.png" alt="ibon 首頁的列印掃描選單，取件編號列印已標示" role="button" tabindex="0"></li><li><div class="tutorial-step">選擇「條碼辨識輸入」，讓 ibon 機台掃描上方 QR Code 後，選擇所有圖檔，然後預覽一下，沒問題就可以列印囉。</div><img class="tutorial-image" src="/assets/ibon_step2.png" alt="ibon 的條碼辨識輸入按鈕已標示" role="button" tabindex="0"></li><li><div class="tutorial-step">列印後記得拿著 ibon 跑出來的小白紙到櫃台結帳喔！</div></li></ol></section>
    </section>
  </main>
  <div id="lightbox" class="lightbox" hidden role="dialog" aria-modal="true" aria-label="教學圖片放大瀏覽"><img id="lightbox-image" alt=""></div>
  <script>
    const lightbox = document.querySelector('#lightbox');
    const lightboxImage = document.querySelector('#lightbox-image');
    const closeLightbox = () => {{ lightbox.hidden = true; lightboxImage.removeAttribute('src'); }};
    document.querySelectorAll('.tutorial-image').forEach((image) => {{
      const openLightbox = () => {{ lightboxImage.src = image.currentSrc || image.src; lightboxImage.alt = image.alt; lightbox.hidden = false; }};
      image.addEventListener('click', openLightbox);
      image.addEventListener('keydown', (event) => {{ if (event.key === 'Enter' || event.key === ' ') {{ event.preventDefault(); openLightbox(); }} }});
    }});
    lightbox.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (event) => {{ if (event.key === 'Escape' && !lightbox.hidden) closeLightbox(); }});
  </script>
</body>
</html>"""
