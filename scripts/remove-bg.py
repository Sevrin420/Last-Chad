#!/usr/bin/env python3
"""
remove-bg.py  —  Remove the purple background from Last Chad NFT cards.

Flood-fills outward from all four edges (so only the exterior purple is
removed, leaving the purple gem icon inside the card untouched).

Usage:
    python3 scripts/remove-bg.py

All PNG files in assets/chads/ are updated in-place.
"""

import os
from collections import deque
from PIL import Image

CHADS_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'chads')

# Colour-match tolerance — increase if edges look frayed, decrease if
# non-background pixels are being removed.
TOLERANCE = 38


def color_distance(c1, c2):
    """Euclidean distance in RGB space."""
    return ((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2) ** 0.5


def remove_background(path):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    pixels = img.load()

    # Sample the background colour from all four corners and take the average
    corners = [(0,0), (w-1,0), (0,h-1), (w-1,h-1)]
    samples = [pixels[x, y][:3] for (x, y) in corners]
    bg_r = sum(s[0] for s in samples) // len(samples)
    bg_g = sum(s[1] for s in samples) // len(samples)
    bg_b = sum(s[2] for s in samples) // len(samples)
    bg_color = (bg_r, bg_g, bg_b)

    # BFS flood-fill starting from every edge pixel that matches the background
    visited = [[False] * h for _ in range(w)]
    queue = deque()

    def enqueue_if_bg(x, y):
        if 0 <= x < w and 0 <= y < h and not visited[x][y]:
            c = pixels[x, y][:3]
            if color_distance(c, bg_color) <= TOLERANCE:
                visited[x][y] = True
                queue.append((x, y))

    # Seed from all four edges
    for x in range(w):
        enqueue_if_bg(x, 0)
        enqueue_if_bg(x, h - 1)
    for y in range(h):
        enqueue_if_bg(0, y)
        enqueue_if_bg(w - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)   # make transparent
        for dx, dy in ((-1,0),(1,0),(0,-1),(0,1)):
            enqueue_if_bg(x + dx, y + dy)

    img.save(path)


def main():
    chads_dir = os.path.abspath(CHADS_DIR)
    pngs = sorted(
        f for f in os.listdir(chads_dir)
        if f.lower().endswith('.png')
    )

    if not pngs:
        print(f"No PNG files found in {chads_dir}")
        return

    print(f"Processing {len(pngs)} file(s) in {chads_dir}\n")
    for fname in pngs:
        path = os.path.join(chads_dir, fname)
        print(f"  {fname} ...", end=' ', flush=True)
        try:
            remove_background(path)
            print("done")
        except Exception as e:
            print(f"ERROR: {e}")

    print("\nAll done — backgrounds removed.")


if __name__ == '__main__':
    main()
