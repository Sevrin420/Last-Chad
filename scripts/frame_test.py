"""
frame_test.py — Composites a random Google Drive image inside each frame PNG.

Usage:
    python scripts/frame_test.py

- Reads frames from:  assets/frames/*.png
- Outputs results to: assets/frames/test/<frame_name>.png

The source image is scaled to fit inside the frame (smaller than the hole),
centered, and the frame is composited on top. The frame ring naturally covers
any edge overflow.
"""

import os
import random
import tempfile
from pathlib import Path
from PIL import Image
import gdown

FRAMES_DIR = Path("assets/frames")
OUTPUT_DIR = FRAMES_DIR / "test"
GDRIVE_FOLDER_ID = "1ur5p7r2jSUDsMD2csbxh_ZUToN7wlsJW"
# Image fills this fraction of the frame's smaller dimension (tweak if needed)
IMAGE_SCALE = 0.72


def download_random_drive_image(folder_id: str, dest_path: str) -> str:
    """Download a random image from a public Google Drive folder."""
    url = f"https://drive.google.com/drive/folders/{folder_id}"
    file_list = gdown.download_folder(url, quiet=True, use_cookies=False, remaining_ok=True)

    if not file_list:
        raise RuntimeError("Could not list files from Google Drive folder. Check it is publicly shared.")

    # Filter to image files only
    images = [f for f in file_list if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    if not images:
        raise RuntimeError("No image files found in the Drive folder.")

    chosen = random.choice(images)
    print(f"  Selected Drive image: {os.path.basename(chosen)}")
    return chosen


def find_hole_bbox(frame: Image.Image):
    """
    Find the bounding box of the transparent hole in the center of the frame.
    Uses flood fill from the four corners to mark 'outside' transparent pixels.
    Remaining transparent pixels = the interior hole.
    Returns (left, upper, right, lower) or None if no hole found.
    """
    rgba = frame.convert("RGBA")
    width, height = rgba.size
    alpha = rgba.split()[3]  # alpha channel

    # Build a set of all transparent pixel coords
    transparent = set()
    for y in range(height):
        for x in range(width):
            if alpha.getpixel((x, y)) < 10:
                transparent.add((x, y))

    if not transparent:
        return None

    # Flood fill from corners to find 'outside' transparent pixels
    outside = set()
    queue = []
    corners = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    for cx, cy in corners:
        if (cx, cy) in transparent and (cx, cy) not in outside:
            queue.append((cx, cy))
            outside.add((cx, cy))

    while queue:
        x, y = queue.pop()
        for nx, ny in [(x+1, y), (x-1, y), (x, y+1), (x, y-1)]:
            if 0 <= nx < width and 0 <= ny < height:
                if (nx, ny) in transparent and (nx, ny) not in outside:
                    outside.add((nx, ny))
                    queue.append((nx, ny))

    # Hole = transparent pixels not reachable from outside
    hole = transparent - outside
    if not hole:
        # No distinct hole — fall back to center 60% of frame as target
        cx, cy = width // 2, height // 2
        hw = int(width * 0.6) // 2
        hh = int(height * 0.6) // 2
        return (cx - hw, cy - hh, cx + hw, cy + hh)

    xs = [p[0] for p in hole]
    ys = [p[1] for p in hole]
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def composite(frame_path: Path, source_image: Image.Image, output_path: Path):
    frame = Image.open(frame_path).convert("RGBA")
    fw, fh = frame.size

    hole = find_hole_bbox(frame)
    if hole:
        hx, hy, hx2, hy2 = hole
        hole_w = hx2 - hx
        hole_h = hy2 - hy
    else:
        # Fallback: use 70% of frame size, centered
        hole_w = int(fw * IMAGE_SCALE)
        hole_h = int(fh * IMAGE_SCALE)
        hx = (fw - hole_w) // 2
        hy = (fh - hole_h) // 2

    # Scale source to fill the hole (cover), then center-crop
    src = source_image.convert("RGBA")
    sw, sh = src.size
    scale = max(hole_w / sw, hole_h / sh)
    new_w = int(sw * scale)
    new_h = int(sh * scale)
    src = src.resize((new_w, new_h), Image.LANCZOS)

    # Center crop to hole size
    crop_x = (new_w - hole_w) // 2
    crop_y = (new_h - hole_h) // 2
    src = src.crop((crop_x, crop_y, crop_x + hole_w, crop_y + hole_h))

    # Compose: blank canvas → paste image at hole position → frame on top
    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    canvas.paste(src, (hx, hy))
    canvas = Image.alpha_composite(canvas, frame)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, "PNG")
    print(f"  Saved: {output_path}")


def main():
    frames = sorted(FRAMES_DIR.glob("*.png"))
    if not frames:
        print(f"No PNG frames found in {FRAMES_DIR}. Add frame files and re-run.")
        return

    print(f"Found {len(frames)} frame(s).")
    print("Downloading random image from Google Drive...")

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            chosen = download_random_drive_image(GDRIVE_FOLDER_ID, tmpdir)
            source = Image.open(chosen)
        except Exception as e:
            print(f"Drive download failed: {e}")
            return

        print(f"Compositing into {len(frames)} frame(s)...")
        for frame_path in frames:
            out = OUTPUT_DIR / frame_path.name
            composite(frame_path, source, out)

    print("Done.")


if __name__ == "__main__":
    main()
