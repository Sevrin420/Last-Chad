"""
generate_50_chads.py — Download 50 images from a public Google Drive folder,
composite them into steelbg.png using hole-detection, save as assets/chads/21-70.png.
"""

import sys
import tempfile
from pathlib import Path

import gdown
from PIL import Image

GDRIVE_FOLDER_ID = "1xv9SJI4FJrl2A0EVrXpbqNiKUzyHrfDn"
FRAME_PATH       = Path("assets/frames/steelbg.png")
OUTPUT_DIR       = Path("assets/chads")
START_INDEX      = 21
IMAGE_EXTS       = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


# ---------------------------------------------------------------------------
# Compositing (same logic as frame_test.py)
# ---------------------------------------------------------------------------

def find_hole_bbox(frame: Image.Image):
    rgba   = frame.convert("RGBA")
    width, height = rgba.size
    alpha  = rgba.split()[3]

    transparent = set()
    for y in range(height):
        for x in range(width):
            if alpha.getpixel((x, y)) < 10:
                transparent.add((x, y))

    if not transparent:
        return None

    outside = set()
    queue   = []
    for cx, cy in [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]:
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

    hole = transparent - outside
    if not hole:
        cx, cy = width // 2, height // 2
        hw = int(width * 0.6) // 2
        hh = int(height * 0.6) // 2
        return (cx - hw, cy - hh, cx + hw, cy + hh)

    xs = [p[0] for p in hole]
    ys = [p[1] for p in hole]
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def composite(frame: Image.Image, source_path: Path, output_path: Path):
    fw, fh = frame.size
    hole   = find_hole_bbox(frame)

    if hole:
        hx, hy, hx2, hy2 = hole
        hole_w = hx2 - hx
        hole_h = hy2 - hy
    else:
        hole_w = int(fw * 0.72)
        hole_h = int(fh * 0.72)
        hx = (fw - hole_w) // 2
        hy = (fh - hole_h) // 2

    src    = Image.open(source_path).convert("RGBA")
    sw, sh = src.size
    scale  = max(hole_w / sw, hole_h / sh)
    new_w  = int(sw * scale)
    new_h  = int(sh * scale)
    src    = src.resize((new_w, new_h), Image.LANCZOS)

    crop_x = (new_w - hole_w) // 2
    crop_y = (new_h - hole_h) // 2
    src    = src.crop((crop_x, crop_y, crop_x + hole_w, crop_y + hole_h))

    canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    canvas.paste(src, (hx, hy))
    canvas = Image.alpha_composite(canvas, frame)
    canvas.save(output_path, "PNG")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not FRAME_PATH.exists():
        print(f"ERROR: frame not found at {FRAME_PATH}")
        sys.exit(1)

    print(f"Loading frame from {FRAME_PATH} ...")
    frame = Image.open(FRAME_PATH).convert("RGBA")
    print(f"Frame size: {frame.width} x {frame.height}")

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"\nDownloading Drive folder {GDRIVE_FOLDER_ID} ...")
        gdown.download_folder(
            id=GDRIVE_FOLDER_ID,
            output=tmpdir,
            quiet=False,
            use_cookies=False,
            remaining_ok=True,
        )

        all_images = sorted(
            p for p in Path(tmpdir).rglob("*")
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS
        )

        if not all_images:
            print("ERROR: No image files found in the Drive folder.")
            sys.exit(1)

        print(f"\nFound {len(all_images)} image(s).\n")
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        saved = 0
        for i, src in enumerate(all_images):
            try:
                with Image.open(src) as test:
                    test.load()
            except Exception as e:
                print(f"  [{i+1}] Skipping {src.name} — not a valid image: {e}")
                continue

            out_path = OUTPUT_DIR / f"{START_INDEX + saved}.png"
            composite(frame, src, out_path)
            print(f"  [{i+1}] {src.name} → {out_path.name}")
            saved += 1

    print(f"\nDone — {saved} image(s) saved to {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
