#!/usr/bin/env python3
"""
apply_frame.py — Apply Last Chad border frame to all chad NFT images

Usage:
  1. Save the frame PNG to: assets/frame.png
  2. Run: python3 scripts/apply_frame.py

Output: assets/chads/framed/1.png ... 20.png
"""

from PIL import Image
import os
import sys

FRAME_PATH   = "assets/frame.png"
CHADS_DIR    = "assets/chads"
OUTPUT_DIR   = "assets/chads/framed"
BLACK_THRESH = 25   # RGB values all below this → treated as transparent


def make_frame_transparent(frame_img):
    """Replace near-black pixels (background + window) with alpha=0."""
    frame = frame_img.convert("RGBA")
    data  = frame.load()
    w, h  = frame.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = data[x, y]
            if r < BLACK_THRESH and g < BLACK_THRESH and b < BLACK_THRESH:
                data[x, y] = (0, 0, 0, 0)
    return frame


def cover_crop(img, target_w, target_h):
    """Scale image to cover target size, then center-crop (no distortion)."""
    img_w, img_h = img.size
    scale  = max(target_w / img_w, target_h / img_h)
    new_w  = int(img_w * scale)
    new_h  = int(img_h * scale)
    img    = img.resize((new_w, new_h), Image.LANCZOS)
    left   = (new_w - target_w) // 2
    top    = (new_h - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def apply_frame(chad_path, frame_rgba, output_path):
    fw, fh = frame_rgba.size

    chad         = Image.open(chad_path).convert("RGBA")
    chad_cropped = cover_crop(chad, fw, fh)

    # Composite: chad photo → frame overlay
    result = chad_cropped.copy()
    result.paste(frame_rgba, (0, 0), frame_rgba)
    result.save(output_path, "PNG")
    print(f"  ✓  {os.path.basename(output_path)}")


def main():
    if not os.path.exists(FRAME_PATH):
        print(f"ERROR: Frame not found at {FRAME_PATH}")
        print("  Save the Last Chad border PNG there, then re-run.")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Loading frame from {FRAME_PATH} ...")
    frame_raw   = Image.open(FRAME_PATH)
    frame_rgba  = make_frame_transparent(frame_raw)
    fw, fh      = frame_rgba.size
    print(f"Frame size: {fw} x {fh}  (transparent window + background)")

    print(f"\nProcessing chads in {CHADS_DIR}/ ...")
    processed = 0
    for fname in sorted(os.listdir(CHADS_DIR)):
        if not fname.endswith(".png"):
            continue
        chad_path   = os.path.join(CHADS_DIR, fname)
        output_path = os.path.join(OUTPUT_DIR, fname)
        apply_frame(chad_path, frame_rgba, output_path)
        processed += 1

    print(f"\nDone — {processed} images saved to {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
