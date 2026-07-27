"""Compose the 1200x630 link-preview card from the studio logo and a tagline.

Run after changing the logo or the tagline:

    uv run --with pillow python scripts/build-share-card.py

Kept as a script rather than a build step: the inputs change about never, and
a checked-in PNG means the deploy has one less thing that can fail. It does
need a CJK font on the machine that runs it — see FONT_CANDIDATES.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
LOGO = ROOT / "frontend" / "public" / "assets" / "luma-studio-logo.png"
OUTPUT = ROOT / "frontend" / "public" / "assets" / "share-card.png"

# The 1.91:1 ratio Facebook, LINE and X all crop toward.
WIDTH, HEIGHT = 1200, 630

# A warm card rather than the site's near-white: Facebook and LINE both put
# link cards on a pale grey, and #f7f6f2 disappeared into it.
TOP_TONE = (248, 245, 239)
BOTTOM_TONE = (236, 229, 216)
HIGHLIGHT = (255, 253, 248)
TEXT_TONE = (94, 111, 106)

TAGLINE = "台中・桃園開課｜兒童美術 × 成人肌理畫"
TAGLINE_SIZE = 42
LOGO_WIDTH = 470
GAP = 54

# Pillow needs a real font file for CJK; the stack default draws blanks.
FONT_CANDIDATES = [
    ("C:/Windows/Fonts/msjh.ttc", 0),
    ("C:/Windows/Fonts/msjhbd.ttc", 0),
    ("/System/Library/Fonts/PingFang.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path, index in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size, index=index)
    raise SystemExit(
        "No CJK font found. Add one to FONT_CANDIDATES in this script, or run it\n"
        "on a machine with 微軟正黑體 / PingFang / Noto Sans CJK installed."
    )


def background() -> Image.Image:
    """A soft vertical wash with a highlight behind the logo."""

    card = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(card)
    for y in range(HEIGHT):
        ratio = y / (HEIGHT - 1)
        draw.line(
            [(0, y), (WIDTH, y)],
            fill=tuple(round(TOP_TONE[i] + (BOTTOM_TONE[i] - TOP_TONE[i]) * ratio) for i in range(3)),
        )

    glow = Image.new("L", (WIDTH, HEIGHT), 0)
    glow_draw = ImageDraw.Draw(glow)
    steps = 110
    for step in range(steps, 0, -1):
        radius = WIDTH * 0.5 * (step / steps)
        alpha = int(120 * (1 - step / steps) ** 1.7)
        glow_draw.ellipse(
            [WIDTH / 2 - radius, HEIGHT * 0.38 - radius, WIDTH / 2 + radius, HEIGHT * 0.38 + radius],
            fill=alpha,
        )
    card.paste(Image.new("RGB", (WIDTH, HEIGHT), HIGHLIGHT), (0, 0), glow)
    return card


def build() -> None:
    card = background()
    draw = ImageDraw.Draw(card)
    font = load_font(TAGLINE_SIZE)

    logo = Image.open(LOGO).convert("RGBA")
    logo_height = round(logo.height * (LOGO_WIDTH / logo.width))
    logo = logo.resize((LOGO_WIDTH, logo_height), Image.LANCZOS)

    left, top, right, bottom = draw.textbbox((0, 0), TAGLINE, font=font)
    text_width, text_height = right - left, bottom - top

    # Centre the logo and tagline as one block, not each on its own.
    block_height = logo_height + GAP + text_height
    block_top = (HEIGHT - block_height) // 2

    card.paste(logo, ((WIDTH - LOGO_WIDTH) // 2, block_top), logo)
    draw.text(
        ((WIDTH - text_width) // 2 - left, block_top + logo_height + GAP - top),
        TAGLINE,
        font=font,
        fill=TEXT_TONE,
    )

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    card.save(OUTPUT, "PNG", optimize=True)
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    build()
