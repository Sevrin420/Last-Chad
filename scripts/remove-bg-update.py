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

# Colour-match tolerance for BFS flood-fill.
# Lower = preserves dark border; higher = removes more purple texture.
TOLERANCE = 55

# Cleanup passes: after BFS, pixels with this many transparent neighbours
# (out of 4) are also made transparent. Removes leftover dark texture spots
# without touching the dark border (which sits next to opaque brown pixels).
CLEANUP_PASSES = 3
CLEANUP_THRESHOLD = 3  # neighbours that must be transparent to trigger removal


def color_distance(c1, c2):
    return ((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2) ** 0.5


def remove_background(img):
    """Return a copy of img with the exterior purple made transparent."""
    img = img.convert("RGBA")
    w, h = img.size
    pixels = img.load()

    # Sample many points along all four edges for a robust background reference
    edge_samples = []
    step = max(1, min(w, h) // 20)
    for x in range(0, w, step):
        edge_samples.append(pixels[x, 0][:3])
        edge_samples.append(pixels[x, h-1][:3])
    for y in range(0, h, step):
        edge_samples.append(pixels[0, y][:3])
        edge_samples.append(pixels[w-1, y][:3])
    n = len(edge_samples)
    bg_color = (
        sum(s[0] for s in edge_samples) // n,
        sum(s[1] for s in edge_samples) // n,
        sum(s[2] for s in edge_samples) // n,
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

    # Cleanup passes: remove leftover dark texture spots that the BFS missed
    # because they were too dark to match the background colour. A pixel is
    # removed only if CLEANUP_THRESHOLD or more of its 4 neighbours are already
    # transparent — this safely skips the dark border, which always has opaque
    # brown pixels beside it.
    for _ in range(CLEANUP_PASSES):
        to_clear = []
        for y in range(h):
            for x in range(w):
                if pixels[x, y][3] != 0:  # not already transparent
                    transparent_neighbours = sum(
                        1 for dx, dy in ((-1,0),(1,0),(0,-1),(0,1))
                        if 0 <= x+dx < w and 0 <= y+dy < h
                        and pixels[x+dx, y+dy][3] == 0
                    )
                    if transparent_neighbours >= CLEANUP_THRESHOLD:
                        to_clear.append((x, y))
        for x, y in to_clear:
            pixels[x, y] = (0, 0, 0, 0)

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
