#!/usr/bin/env python3
"""
remove-bg-update.py  —  Remove purple background from updated Last Chad NFT cards.

Reads PNGs from assets/chads/update/, strips the exterior purple background
via edge-seeded BFS flood-fill, then saves the results as:
    assets/chads/nobg/00001_brownbg.png
    assets/chads/nobg/00002_brownbg.png
    ...

Usage:
    python3 scripts/remove-bg-update.py
"""

import os
from collections import deque
from PIL import Image

BASE_DIR   = os.path.join(os.path.dirname(__file__), '..')
UPDATE_DIR = os.path.join(BASE_DIR, 'assets', 'chads', 'update')
NOBG_DIR   = os.path.join(BASE_DIR, 'assets', 'chads', 'nobg')

# Colour-match tolerance — increase if edges look frayed, decrease if
# non-background pixels are being removed.
TOLERANCE = 38


def color_distance(c1, c2):
    return ((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2) ** 0.5


def remove_background(img):
    """Return a copy of img with the exterior purple made transparent."""
    img = img.convert("RGBA")
    w, h = img.size
    pixels = img.load()

    corners = [(0, 0), (w-1, 0), (0, h-1), (w-1, h-1)]
    samples = [pixels[x, y][:3] for (x, y) in corners]
    bg_color = (
        sum(s[0] for s in samples) // 4,
        sum(s[1] for s in samples) // 4,
        sum(s[2] for s in samples) // 4,
    )

    visited = [[False] * h for _ in range(w)]
    queue = deque()

    def enqueue_if_bg(x, y):
        if 0 <= x < w and 0 <= y < h and not visited[x][y]:
            if color_distance(pixels[x, y][:3], bg_color) <= TOLERANCE:
                visited[x][y] = True
                queue.append((x, y))

    for x in range(w):
        enqueue_if_bg(x, 0)
        enqueue_if_bg(x, h - 1)
    for y in range(h):
        enqueue_if_bg(0, y)
        enqueue_if_bg(w - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            enqueue_if_bg(x + dx, y + dy)

    return img


def main():
    update_dir = os.path.abspath(UPDATE_DIR)
    nobg_dir   = os.path.abspath(NOBG_DIR)

    pngs = sorted(
        f for f in os.listdir(update_dir)
        if f.lower().endswith('.png')
    )

    if not pngs:
        print(f"No PNG files found in {update_dir}")
        return

    os.makedirs(nobg_dir, exist_ok=True)

    print(f"Processing {len(pngs)} file(s) from {update_dir}")
    print(f"Saving to {nobg_dir}\n")

    for i, fname in enumerate(pngs, start=1):
        src = os.path.join(update_dir, fname)
        out_name = f"{i:05d}_brownbg.png"
        dst = os.path.join(nobg_dir, out_name)

        print(f"  {fname} → {out_name} ...", end=' ', flush=True)
        try:
            img = Image.open(src)
            result = remove_background(img)
            result.save(dst)
            print("done")
        except Exception as e:
            print(f"ERROR: {e}")

    print("\nAll done — backgrounds removed.")


if __name__ == '__main__':
    main()
