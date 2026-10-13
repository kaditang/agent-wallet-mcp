#!/usr/bin/env python3
# Square app icon (docs/icon.png, 512x512) for connector directories and the
# Claude connector listing. Same palette as scripts/gen-og.py / docs/index.html:
# dark tile, Solana purple→green gradient ring, bold "ay" monogram.
# Run: `python3 scripts/gen-icon.py`. Commit the PNG in docs/.

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

S = 512
SCALE = 4  # supersample for smooth edges
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "icon.png"

BG = (14, 14, 16)
TEXT = (250, 250, 250)
SOLANA_A = (153, 69, 255)
SOLANA_B = (20, 241, 149)


def font(size):
    for c in [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]:
        if Path(c).exists():
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default()


W = S * SCALE
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))

# Rounded dark tile.
tile = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(tile).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=BG + (255,))
img.alpha_composite(tile)

# Diagonal purple→green gradient, shown only through a ring mask.
grad = Image.new("RGBA", (W, W))
gd = ImageDraw.Draw(grad)
for i in range(2 * W):
    t = i / (2 * W)
    col = tuple(int(SOLANA_A[k] * (1 - t) + SOLANA_B[k] * t) for k in range(3)) + (255,)
    gd.line([(i, 0), (0, i)], fill=col, width=2)
ring = Image.new("L", (W, W), 0)
rd = ImageDraw.Draw(ring)
m, th = int(W * 0.13), int(W * 0.045)
rd.ellipse([m, m, W - m, W - m], fill=255)
rd.ellipse([m + th, m + th, W - m - th, W - m - th], fill=0)
img.paste(grad, (0, 0), ring)

# Monogram.
d = ImageDraw.Draw(img)
f = font(int(W * 0.30))
txt = "ay"
bbox = d.textbbox((0, 0), txt, font=f)
tw, thh = bbox[2] - bbox[0], bbox[3] - bbox[1]
d.text(((W - tw) / 2 - bbox[0], (W - thh) / 2 - bbox[1] - W * 0.01), txt, font=f, fill=TEXT + (255,))

img.resize((S, S), Image.LANCZOS).save(OUT)
print(f"wrote {OUT}")
