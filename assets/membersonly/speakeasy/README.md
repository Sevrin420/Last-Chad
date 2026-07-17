# Speakeasy Pixels — asset pack

20 hand-generated 1920s speakeasy characters (10 women, 10 men) as top-down
game sprites + NFT portraits. Dropped in for **Club Nile** (`games/clubnile.html`).

## What's here

| Folder / file | Contents |
|---|---|
| `nft/` | 20 × 512px front-facing portraits — the NFT / card / dialogue art |
| `spritesheets/` | 20 × sheets, **4 rows (S,N,W,E) × 4 walk frames**, uniform cells |
| `frames/<char>/` | 24 individual PNGs per character: `{S,N,W,E}_walk0..3.png` + `{S,N,W,E}_idle0..1.png` |
| `previews/` | animated GIFs (walk 180ms/frame, idle 500ms/frame) — **reference only** |
| `cast_sheet.png` | all 20 characters on one sheet |
| `collection_preview.png` | promo grid |
| `manifest.json` | machine-readable structure + cast list |
| `USAGE_GUIDE.md` | **full authoring guide** — read this first |

## The cast (`manifest.json`)

`m01_mobboss` Mob Boss · `m02_bouncer` Bouncer · `m03_bartender` Bartender ·
`m04_saxophone` Saxophonist · `m05_trumpet` Trumpeter · `m06_pianist` Pianist ·
`m07_bootlegger` Bootlegger · `m08_detective` Detective · `m09_gambler` Gambler ·
`m10_gentleman` Gentleman · `f01_flapper` Flapper · `f02_singer` Jazz Singer ·
`f03_dancer` Charleston Dancer · `f04_socialite` Socialite ·
`f05_cigarette` Cigarette Girl · `f06_waitress` Waitress · `f07_newsgirl` Newsgirl ·
`f08_madame` The Madame · `f09_reporter` Reporter · `f10_showgirl` Showgirl

## Golden rules (from `USAGE_GUIDE.md`)

- **Always scale nearest-neighbor.** Bilinear smoothing turns pixel art to mush.
- **Spritesheet layout:** rows `S,N,W,E`; columns = walk frames `0→1→2→3→loop`.
  Cell size = `imageWidth / 4` (compute at load; native cells are big — meant to be
  downscaled). `E` is a mirror of `W`.
- **Timing:** walk ≈ 6 fps (150–200 ms/frame), idle ≈ 2 fps (~500 ms).
- **In-world size:** target ~48–96 px tall; downscale by integer factors. The 512px
  portraits are for menus/cards only, never the walking sprite.

## How Club Nile uses them

The game reads these sheets, slices each into the 4-direction walk cycle, and
draws them (nearest-neighbor, downscaled) for the player and NPCs. Roles map to
the obvious cast member — bartender → `m03_bartender`, pianist → `m06_pianist`,
dealers/guests → the rest. Portraits in `nft/` back the collection cards.

## `game/` — derived in-engine sprites

`game/` holds tiny, downscaled sheets the game actually loads (2 walk frames ×
rows S,N,W, feet-aligned, ~54px tall, nearest-neighbor). Generated from
`spritesheets/` by trimming each direction independently and padding to a uniform
cell — `clubnile.html` slices them into `{down,up,left,right}` and mirrors `W→E`.

**Only 10 characters have clean 4-direction art in this source pack** and are the
ones used for walking NPCs/player:

`f02_singer · f06_waitress · f08_madame · f09_reporter · f10_showgirl ·
m01_mobboss · m02_bouncer · m05_trumpet · m06_pianist · m09_gambler`

## Caveat — malformed views

The other 10 characters (`f01,f03,f04,f05,f07,m03,m04,m07,m08,m10`) have
**malformed back and/or side cells** in the source spritesheets — the image
generator produced garbage for those directions (e.g. `m08_detective`'s back is a
stack of hat blobs; `m07_bootlegger`'s sides are a documented placeholder). Their
**front-facing NFT portraits are fine** (use them for cards), but they're excluded
from the in-world cast until regenerated. Re-run `speakeasy_generator.py` when the
image quota refreshes (see `USAGE_GUIDE.md` §8) to fix the bad directions, then
add them back to `SPEAK_KEYS` in `games/clubnile.html`.
