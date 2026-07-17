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

## Caveat

`m07_bootlegger`'s W/E (side) views are a placeholder (his back view) — the
generator's image quota ran out mid-production. Regenerate with
`speakeasy_generator.py` when quota refreshes (see `USAGE_GUIDE.md` §8).
