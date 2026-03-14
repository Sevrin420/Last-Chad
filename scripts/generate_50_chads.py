"""
generate_50_chads.py — Pick 50 random images from Google Drive, apply
frame.png, and save as assets/chads/21.png through 70.png.

Steps:
  1. Fetch the Drive folder page and scrape file IDs (no API key needed).
  2. Randomly select 50 IDs.
  3. Download each file individually with gdown.
  4. Apply assets/frames/frame.png (near-black pixels treated as transparent).
  5. Save output as assets/chads/21.png ... 70.png.
"""

import os
import re
import sys
import random
import tempfile
import requests
import gdown
from pathlib import Path
from PIL import Image

GDRIVE_FOLDER_ID = "1ur5p7r2jSUDsMD2csbxh_ZUToN7wlsJW"
FRAME_PATH       = Path("assets/frames/frame.png")
OUTPUT_DIR       = Path("assets/chads")
START_INDEX      = 21
COUNT            = 50
BLACK_THRESH     = 25   # pixels with R,G,B all below this become transparent


# ---------------------------------------------------------------------------
# Drive listing
# ---------------------------------------------------------------------------

def list_drive_file_ids(folder_id: str) -> list[str]:
    """
    Fetch the public Drive folder page and extract all file IDs.
    File IDs appear in href="/file/d/{id}/view" anchors embedded in the HTML.
    """
    url     = f"https://drive.google.com/drive/folders/{folder_id}"
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"}
    resp    = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()

    ids = list(set(re.findall(r"/file/d/([A-Za-z0-9_-]{25,})/view", resp.text)))
    return ids


# ---------------------------------------------------------------------------
# Image framing (matches apply_frame.py logic)
# ---------------------------------------------------------------------------

def make_frame_transparent(frame_img: Image.Image) -> Image.Image:
    """Replace near-black pixels with alpha=0 to reveal the artwork behind."""
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
    """Scale to cover target dimensions, then center-crop."""
    iw, ih = img.size
    scale  = max(target_w / iw, target_h / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img    = img.resize((nw, nh), Image.LANCZOS)
    left   = (nw - target_w) // 2
    top    = (nh - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def apply_frame(source_path: Path, frame_rgba: Image.Image, output_path: Path):
    fw, fh  = frame_rgba.size
    img     = Image.open(source_path).convert("RGBA")
    img     = cover_crop(img, fw, fh)
    result  = img.copy()
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

    print(f"\nFetching file list from Drive folder {GDRIVE_FOLDER_ID} ...")
    all_ids = list_drive_file_ids(GDRIVE_FOLDER_ID)
    if not all_ids:
        print("ERROR: No file IDs found. Check the folder is publicly shared.")
        sys.exit(1)
    print(f"Found {len(all_ids)} file(s) in folder.")

    n       = min(COUNT, len(all_ids))
    selected = random.sample(all_ids, n)
    print(f"Selected {n} random file(s).\n")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    saved = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        for i, file_id in enumerate(selected):
            out_num  = START_INDEX + saved
            tmp_path = Path(tmpdir) / f"dl_{i}"

            print(f"[{i+1}/{n}] Downloading {file_id} ...")
            try:
                gdown.download(
                    f"https://drive.google.com/uc?id={file_id}",
                    str(tmp_path),
                    quiet=True,
                )
            except Exception as e:
                print(f"  Download failed: {e} — skipping.")
                continue

            # Verify it's a valid image before framing
            try:
                with Image.open(tmp_path) as test:
                    test.load()
            except Exception as e:
                print(f"  Not a valid image: {e} — skipping.")
                continue

            out_path = OUTPUT_DIR / f"{out_num}.png"
            apply_frame(tmp_path, frame_rgba, out_path)
            print(f"  Saved: {out_path}")
            saved += 1

    print(f"\nDone — {saved} image(s) saved to {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
