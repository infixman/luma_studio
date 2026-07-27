"""Compose the 1200x630 link-preview card from the studio logo.

Run after changing the logo:

    uv run --with pillow python scripts/build-share-card.py

Kept as a script rather than a build step: the logo changes about never, and
a checked-in PNG means the deploy has one less thing that can fail.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LOGO = ROOT / "frontend" / "public" / "assets" / "luma-studio-logo.png"
OUTPUT = ROOT / "frontend" / "public" / "assets" / "share-card.png"

# The 1.91:1 ratio Facebook, LINE and X all crop toward.
WIDTH, HEIGHT = 1200, 630
BACKGROUND = (247, 246, 242)
TINT = (234, 241, 236)
LOGO_WIDTH = 620


def radial_tint(size: tuple[int, int]) -> Image.Image:
    """The same soft wash the site's pages use behind their content."""

    width, height = size
    gradient = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(gradient)
    steps = 90
    for step in range(steps, 0, -1):
        radius = width * 0.62 * (step / steps)
        alpha = int(150 * (1 - step / steps) ** 1.6)
        draw.ellipse(
            [
                width / 2 - radius,
                height * 0.16 - radius,
                width / 2 + radius,
                height * 0.16 + radius,
            ],
            fill=alpha,
        )
    return gradient


def build() -> None:
    card = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    card.paste(Image.new("RGB", (WIDTH, HEIGHT), TINT), (0, 0), radial_tint((WIDTH, HEIGHT)))

    logo = Image.open(LOGO).convert("RGBA")
    height = round(logo.height * (LOGO_WIDTH / logo.width))
    logo = logo.resize((LOGO_WIDTH, height), Image.LANCZOS)
    card.paste(logo, ((WIDTH - LOGO_WIDTH) // 2, (HEIGHT - height) // 2), logo)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    card.save(OUTPUT, "PNG", optimize=True)
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    build()
