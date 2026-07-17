# Speakeasy Pixels — Game Asset Usage Guide

Everything you need to drop the 20 speakeasy characters into a top-down game.
No special tools required — all assets are plain PNGs and GIFs with transparent backgrounds.

---

## 1. What's in the pack

```
speakeasy/
├── nft/               20 front-facing 512px portraits (the NFT art)
├── spritesheets/      20 sheets: 4 directions × 4 walk frames, uniform cells
├── frames/            20 folders of individual frame PNGs (easiest to use)
├── previews/          Animated GIFs (walk + idle) for quick reference
├── cast_sheet.png     All 20 characters on one sheet
└── manifest.json      Machine-readable structure + cast list
```

**The golden rule:** these are pixel-art sprites. Always scale with
**nearest-neighbor**, never bilinear/trilinear filtering, or they turn to mush.

---

## 2. The `frames/` folder (recommended starting point)

Each character folder contains 24 PNGs:

```
frames/m01_mobboss/
├── S_walk0.png  S_walk1.png  S_walk2.png  S_walk3.png   # walking South (toward camera)
├── N_walk0.png  N_walk1.png  N_walk2.png  N_walk3.png   # walking North (away)
├── W_walk0.png  W_walk1.png  W_walk2.png  W_walk3.png   # walking West (left)
├── E_walk0.png  E_walk1.png  E_walk2.png  E_walk3.png   # walking East (right)
├── S_idle0.png  S_idle1.png                             # idle "vibe" bob, South
├── N_idle0.png  N_idle1.png                             # idle, North
├── W_idle0.png  W_idle1.png                             # idle, West
└── E_idle0.png  E_idle1.png                             # idle, East
```

### Walk cycle
Play frames **0 → 1 → 2 → 3 → loop**:

| Frame | Pose |
|-------|------|
| 0 | Standing (contact) |
| 1 | Left step + slight dip |
| 2 | Standing (contact) |
| 3 | Right step + slight dip |

Recommended timing: **150–200 ms per frame** (5–7 fps). The included preview
GIFs use 180 ms — match your in-game move speed so feet don't "skate"
(roughly: one full cycle per tile crossed).

### Idle "vibe"
Frames `idle0 ↔ idle1` looping at **~500 ms per frame** — a gentle 2 px
breathing bob. Subtle enough for NPC crowds, lively enough for the player.

### Directions
- **S** = facing camera (south), **N** = back (north)
- **W** = facing left, **E** = facing right (E is a mirror of W — standard for
  top-down games and keeps props consistent)

---

## 3. Using the sprite sheets instead

Each `spritesheets/{character}.png` is a grid of **4 rows × 4 columns**:

| Row | Direction |
|-----|-----------|
| 1 | South (front) |
| 2 | North (back) |
| 3 | West (left) |
| 4 | East (right) |

Columns are the 4 walk frames (same order as above).

**Cell size = sheet width ÷ 4 = sheet height ÷ 4** (cells are square and
uniform *within* a sheet, but sizes differ between characters — always compute
it from the image dimensions; don't hardcode).

Idle frames are not on the sheet (to keep it square) — grab them from
`frames/`, or just use walk frame 0 plus your own 1–2 px vertical offset.

---

## 4. Engine-specific setup

### Unity
1. Import the PNGs. In the Inspector set:
   - **Texture Type:** Sprite (2D and UI)
   - **Filter Mode:** Point (no filter)
   - **Compression:** None
   - **Generate Mipmaps:** Off
2. For sheets: **Sprite Mode: Multiple**, slice by grid (cell = width ÷ 4).
3. Build an `AnimatorController` with 8 states (Idle/Walk × 4 directions) and
   blend on a `Direction` parameter, or simply swap sprites in code.
4. Set **Pixels Per Unit** so the character is ~1 unit tall in world space.

### Godot
1. Import with filtering **off** (Project Settings → Rendering → Textures →
   Default Texture Filter → Nearest, or per-node `CanvasItem.texture_filter`).
2. Use `AnimatedSprite2D` → `SpriteFrames` resource. Add animations:
   `walk_s`, `walk_n`, `walk_e`, `walk_w`, `idle_s`, ... and drag the
   individual frame PNGs in from `frames/`.
3. Set walk animation speed to ~6 FPS, idle to 2 FPS, both looping.

### GameMaker
1. Create one sprite per animation (`spr_mobboss_walk_s`, etc.), import the
   frame strips or individual PNGs.
2. Set **Interpolation between pixels: off** in game options.
3. `image_speed` ≈ 0.2 (frames per game-frame at 60 fps ≈ 200 ms/frame).

### Web (canvas/Phaser)
```js
// Phaser example
this.load.spritesheet('mobboss', 'spritesheets/m01_mobboss.png', {
  frameWidth: sheetWidth / 4,   // compute after loading image
  frameHeight: sheetHeight / 4,
});
this.anims.create({
  key: 'mobboss-walk-s',
  frames: this.anims.generateFrameNumbers('mobboss', { start: 0, end: 3 }),
  frameRate: 6,
  repeat: -1,
});
// rows: S=0-3, N=4-7, W=8-11, E=12-15
```
Set `roundPixels: true` in the game config.

---

## 5. Connecting NFTs to in-game characters

The intended flow for your game:

1. Player owns `Speakeasy Pixels #134`.
2. Read `metadata/134.json` → `attributes` gives `Character` (e.g. "Flapper")
   and the colorway of each zone (e.g. Garment: Burgundy).
3. Load `frames/f01_flapper/` for the sprite.
4. **Recolor in-game** to match their exact NFT, in either of two ways:
   - **Pre-render offline (simple):** run `speakeasy_generator.py` with a
     custom combo to produce that player's exact sprite set, or
   - **Runtime palette swap (advanced):** the zones are defined by HSV rules
     (see `RULES` in `speakeasy_generator.py`) — port the ~20 lines of mask
     logic to a shader and swap hue/sat/value per zone at runtime.

The NFT image itself (`nft/{character}.png`) is the character's canonical
front — use it for portraits, dialogue boxes, party menus, and inventory.

---

## 6. Sizing & resolution

- Native sprite height: roughly 300–460 px (varies per character).
- For an LTTP-feel game, target the character occupying **~48–96 px** on
  screen. Downscale by integer factors where possible (1/2, 1/4) or just
  render small with nearest filtering — never upscale with smoothing.
- The 512 px NFT portraits are for menus/portraits, not in-world sprites.

---

## 7. Known caveats

- **m07_bootlegger** W/E views are currently a placeholder (his back view) —
  the image generator's quota ran out during production. All other 19
  characters have proper profile views. Regenerate when quota refreshes.
- Palette-mode PNGs: some editors preview them oddly; they open fine in all
  engines and browsers. If an editor complains, batch-convert to RGBA (any
  tool — color count is tiny).
- GIF previews are reference material, not game assets — use the PNG frames.

---

## 8. Regenerating or extending

```bash
# Re-mint the whole 2222 collection (deterministic)
python3 speakeasy_generator.py --bases ./bases --out ./collection --count 2222 --seed 1920

# A different unique set
python3 speakeasy_generator.py --bases ./bases --out ./collection2 --count 2222 --seed 777
```

Rarity weights, theme colors, and zone rules live at the top of
`speakeasy_generator.py` — tweak them to create seasonal palettes or
rarer grails.
