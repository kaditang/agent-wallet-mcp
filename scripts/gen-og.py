#!/usr/bin/env python3
# One-off generator for docs/og.png — the 1200x630 social-card preview that
# Twitter / Slack / LinkedIn fetch when someone shares an autoyield.org URL.
# Run once: `python3 scripts/gen-og.py`. Commits the resulting PNG to docs/.

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

W, H = 1200, 630
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "og.png"

# Brand palette (matches docs/index.html :root)
BG = (14, 14, 16)       # #0e0e10
TEXT = (250, 250, 250)  # #fafafa
MUTED = (156, 163, 175) # #9ca3af
ACCENT = (102, 56, 232) # #6638e8 — purple
SOLANA_A = (153, 69, 255)  # solana purple
SOLANA_B = (20, 241, 149)  # solana green

def load_font(size, bold=False):
    # macOS-installed fonts. Fall back to default if absent.
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for c in candidates:
        if Path(c).exists():
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default()

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# Accent gradient stripe at top — Solana purple → green.
stripe_h = 8
for x in range(W):
    t = x / W
    r = int(SOLANA_A[0] * (1 - t) + SOLANA_B[0] * t)
    g = int(SOLANA_A[1] * (1 - t) + SOLANA_B[1] * t)
    b = int(SOLANA_A[2] * (1 - t) + SOLANA_B[2] * t)
    d.line([(x, 0), (x, stripe_h)], fill=(r, g, b))

# Subtle accent corner box.
d.rectangle([(W - 220, H - 80), (W - 60, H - 40)], fill=(24, 24, 27))
d.text((W - 200, H - 72), "autoyield.org", fill=MUTED, font=load_font(24))

# Wordmark — top-left, big.
d.text((80, 90), "autoyield", fill=TEXT, font=load_font(96, bold=True))

# One-liner.
d.text(
    (80, 220),
    "Non-custodial RWA + yield",
    fill=TEXT,
    font=load_font(58, bold=True),
)
d.text(
    (80, 290),
    "for AI agents on Solana.",
    fill=TEXT,
    font=load_font(58, bold=True),
)

# Detail lines.
d.text(
    (80, 400),
    "Tokenized US stocks (NVDA / TSLA / SPY) + USDC yield.",
    fill=MUTED,
    font=load_font(30),
)
d.text(
    (80, 445),
    "You sign in your wallet. We never do.",
    fill=MUTED,
    font=load_font(30),
)

# Tag line at bottom.
d.text(
    (80, 530),
    "Works in Claude · Cursor · Claude Code · any MCP client",
    fill=ACCENT,
    font=load_font(26, bold=True),
)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, "PNG", optimize=True)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
