"""
Remove purple background from all images in assets/update/
and rename them sequentially: 00001_Brownbg.png, 00002_Brownbg.png, etc.

Output goes to assets/update/processed/
"""

import os
import sys
import numpy as np
from PIL import Image

INPUT_DIR = "assets/chads/update"
OUTPUT_DIR = "assets/chads/update/processed"
SUFFIX = "_Brownbg"
TOLERANCE = 40  # color similarity tolerance (0-255); raise if edges are choppy


def is_purple(r, g, b):
    """Rough purple detection: high R, low G, high B."""
    return r > 80 and b > 80 and g < (r + b) // 2 - 10


def sample_bg_color(data):
    """
    Sample the background color from the 4 corners.
    Returns the corner value that looks most purple,
    or falls back to top-left if none look purple.
    """
    h, w = data.shape[:2]
    corners = [
        data[0, 0, :3],
        data[0, w - 1, :3],
        data[h - 1, 0, :3],
        data[h - 1, w - 1, :3],
    ]
    for c in corners:
        r, g, b = int(c[0]), int(c[1]), int(c[2])
        if is_purple(r, g, b):
            return c
    # Fallback: just use top-left corner
    return corners[0]


def remove_background(img_path, out_path):
    img = Image.open(img_path).convert("RGBA")
    data = np.array(img, dtype=np.int32)

    bg = sample_bg_color(data).astype(np.int32)

    # Build mask: pixels close to bg color
    diff = np.abs(data[:, :, :3] - bg)
    mask = np.all(diff <= TOLERANCE, axis=2)

    # Zero out alpha for matching pixels
    result = data.copy()
    result[mask, 3] = 0

    out_img = Image.fromarray(result.astype(np.uint8), "RGBA")
    out_img.save(out_path, "PNG")
    return True


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Collect supported image files (skip the processed subfolder)
    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    files = sorted(
        f for f in os.listdir(INPUT_DIR)
        if os.path.splitext(f)[1].lower() in exts
        and os.path.isfile(os.path.join(INPUT_DIR, f))
    )

    if not files:
        print("No images found in", INPUT_DIR)
        sys.exit(0)

    processed = 0
    errors = []

    for idx, filename in enumerate(files, start=1):
        in_path = os.path.join(INPUT_DIR, filename)
        out_name = f"{idx:05d}{SUFFIX}.png"
        out_path = os.path.join(OUTPUT_DIR, out_name)

        try:
            remove_background(in_path, out_path)
            print(f"  {filename} -> {out_name}")
            processed += 1
        except Exception as e:
            print(f"  ERROR: {filename}: {e}")
            errors.append(filename)

    print(f"\nDone: {processed} processed, {len(errors)} errors.")
    if errors:
        print("Failed files:", errors)
        sys.exit(1)


if __name__ == "__main__":
    main()
