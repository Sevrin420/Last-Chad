"""
generate_50_chads.py — Download 50 images from a public Google Drive folder,
apply frame.png, and save as assets/chads/21-70.png.

Steps:
  1. Download the entire Drive folder via gdown.download_folder().
  2. Find all valid image files in the download.
  3. Apply assets/frames/frame.png (near-black pixels become transparent).
  4. Save as assets/chads/21.png ... 70.png.
"""

import sys
import tempfile
from pathlib import Path

import gdown
from PIL import Image

GDRIVE_FOLDER_ID = "1xv9SJI4FJrl2A0EVrXpbqNiKUzyHrfDn"
FRAME_PATH       = Path("assets/frames/frame.png")
OUTPUT_DIR       = Path("assets/chads")
START_INDEX      = 21
BLACK_THRESH     = 25   # R,G,B all below this → transparent
IMAGE_EXTS       = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


# ---------------------------------------------------------------------------
# Image framing (same logic as apply_frame.py)
# ---------------------------------------------------------------------------

def make_frame_transparent(frame_img: Image.Image) -> Image.Image:
    frame = frame_img.convert("RGBA")
    data  = frame.load()
    w, h  = frame.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = data[x, y]
            if r < BLACK_THRESH and g < BLACK_THRESH and b < BLACK_THRESH:
                data[x, y] = (0, 0, 0, 0)
    return frame


def cover_crop(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    iw, ih = img.size
    scale  = max(target_w / iw, target_h / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img    = img.resize((nw, nh), Image.LANCZOS)
    left   = (nw - target_w) // 2
    top    = (nh - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def apply_frame(source_path: Path, frame_rgba: Image.Image, output_path: Path):
    fw, fh = frame_rgba.size
    img    = Image.open(source_path).convert("RGBA")
    img    = cover_crop(img, fw, fh)
    result = img.copy()
    result.paste(frame_rgba, (0, 0), frame_rgba)
    result.save(output_path, "PNG")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not FRAME_PATH.exists():
        print(f"ERROR: frame not found at {FRAME_PATH}")
        sys.exit(1)

    print(f"Loading frame from {FRAME_PATH} ...")
    frame_rgba = make_frame_transparent(Image.open(FRAME_PATH))
    print(f"Frame size: {frame_rgba.width} x {frame_rgba.height}")

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"\nDownloading Drive folder {GDRIVE_FOLDER_ID} ...")
        gdown.download_folder(
            id=GDRIVE_FOLDER_ID,
            output=tmpdir,
            quiet=False,
            use_cookies=False,
        )

        # Collect all image files (recursively, in case of sub-folders)
        all_images = [
            p for p in Path(tmpdir).rglob("*")
            if p.is_file() and p.suffix.lower() in IMAGE_EXTS
        ]

        if not all_images:
            print("ERROR: No image files found in the Drive folder.")
            sys.exit(1)

        print(f"\nFound {len(all_images)} image(s) in folder.")

        selected = sorted(all_images)
        print(f"Using all {len(selected)} image(s).\n")

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        saved = 0
        for i, src in enumerate(selected):
            # Verify it's a valid image
            try:
                with Image.open(src) as test:
                    test.load()
            except Exception as e:
                print(f"  [{i+1}] Skipping {src.name} — not a valid image: {e}")
                continue

            out_path = OUTPUT_DIR / f"{START_INDEX + saved}.png"
            apply_frame(src, frame_rgba, out_path)
            print(f"  [{i+1}] {src.name} → {out_path.name}")
            saved += 1

    print(f"\nDone — {saved} image(s) saved to {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
