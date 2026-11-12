#!/usr/bin/env python3
"""Generate a tangent-space normal map from the dungeon wall diffuse.

Height is approximated from luminance (mortar lines are darker than brick
faces on this texture, so brightness ~ protrusion works), lightly blurred
to suppress JPEG artifacts, then differentiated with a Sobel kernel using
wrap-around sampling so the result tiles as seamlessly as the source.
OpenGL/three.js channel convention: +G tilts the normal toward +V.

Pure PIL — no numpy — so it runs anywhere Pillow is installed. 512x512
takes a couple of seconds.

Usage:
    python3 scripts/generate_wall_normal_map.py [strength]

Reads  public/crawler/textures/wall-tiles.jpg
Writes public/crawler/textures/wall-tiles-normal.png  (PNG: normal maps hate JPEG
chroma artifacts — they turn into lighting noise)
"""

import math
import sys
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "crawler" / "textures" / "wall-tiles.jpg"
DST = ROOT / "public" / "crawler" / "textures" / "wall-tiles-normal.png"

# 2.8 is what the committed wall-tiles-normal.png was generated with — the
# walls carry emissive + ambient light that flattens shading, so the relief
# needs to be slightly overdriven to read under the torch point lights.
STRENGTH = float(sys.argv[1]) if len(sys.argv) > 1 else 2.8


def main():
    src = Image.open(SRC).convert("L").filter(ImageFilter.GaussianBlur(1.0))
    w, h = src.size
    height = list(src.getdata())  # row-major, 0..255

    def hgt(x, y):
        return height[(y % h) * w + (x % w)] / 255.0

    out = Image.new("RGB", (w, h))
    pixels = out.load()
    for y in range(h):
        for x in range(w):
            # Sobel gradients, wrap-around so the map tiles like the source
            sx = (
                hgt(x + 1, y - 1) + 2 * hgt(x + 1, y) + hgt(x + 1, y + 1)
                - hgt(x - 1, y - 1) - 2 * hgt(x - 1, y) - hgt(x - 1, y + 1)
            )
            sy = (
                hgt(x - 1, y + 1) + 2 * hgt(x, y + 1) + hgt(x + 1, y + 1)
                - hgt(x - 1, y - 1) - 2 * hgt(x, y - 1) - hgt(x + 1, y - 1)
            )
            # n = normalize(-dH/du, -dH/dv, 1); image y runs opposite to UV v,
            # so dH/dv = -sy and the G term comes out positive.
            nx = -sx * STRENGTH
            ny = sy * STRENGTH
            inv = 1.0 / math.sqrt(nx * nx + ny * ny + 1.0)
            pixels[x, y] = (
                int((nx * inv * 0.5 + 0.5) * 255),
                int((ny * inv * 0.5 + 0.5) * 255),
                int((inv * 0.5 + 0.5) * 255),
            )

    out.save(DST, optimize=True)
    print(f"wrote {DST} ({DST.stat().st_size} bytes, strength={STRENGTH})")


if __name__ == "__main__":
    main()
