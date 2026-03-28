# games.md — Top Shooter Multiplayer (PvP Arena)

## Overview

3v3 real-time multiplayer top-down shooter. Grid-based movement, bullets only travel upward (from each team's perspective). Teams fight while managing a wall collapse mechanic that squeezes the losing team's playable area.

Built on existing Cloudflare Workers + Durable Objects backend (same architecture as craps).

---

## Core Mechanics

### Controls (mobile-first)
- **D-pad (bottom-left):** 4-direction movement (up/down/left/right, NO diagonal)
- **Shoot button (bottom-right):** fires bullet upward toward enemy side
- **Special/item button:** appears when holding a pickup

### Battlefield
- Grid-based arena (e.g. 12 wide × 16 tall)
- Each team oriented on their own bottom — opposing team always appears on top
- Players cannot move through each other (no stacking)
- Midline divides the field — crossing into enemy territory drains HP slowly

### Bullets
- Travel upward only (toward enemy side)
- Server-authoritative — no client-side hit detection

---

## Classes (assigned randomly, 1 of each per team)

| Class | HP | Speed | Fire Rate | Bullet Damage | Role |
|-------|-----|-------|-----------|---------------|------|
| Tank | High | Slow | Slow | High | Absorbs damage, front line |
| Shooter | Medium | Fast | Fast | Medium | Mobility, flanking |
| Healer | Low | Medium | Slow | Low | Proximity heal aura for nearby teammates |

No mirror matches — every game has 1 tank, 1 shooter, 1 healer per team.

---

## Wall Collapse Mechanic (Trash Compactor)

**Rhythm:** 10 seconds fighting → 3 buttons appear → 5 seconds to press all 3 → repeat

- Walls are the boundaries of each team's playable area
- Both teams start at full width
- Every 10 seconds, 3 buttons spawn on each team's side
- All 3 teammates must stand on a button (hold 1.5 seconds) to prevent collapse
- **Success:** walls stay where they are
- **Fail:** walls close in 1 column from each side — team's arena shrinks
- Buttons require touch-and-hold for 1.5 seconds per button
- Players cannot stack — must go around each other on the grid

### Why this works
- Forces all 3 players to move to specific positions — vulnerable while holding buttons
- Enemy team knows where you'll be standing (predictable positions = easy targets)
- Losing a teammate makes it nearly impossible to press all 3 buttons
- Down to 2 players: one holds button 1, other sprints to button 2 (1.5s hold) then button 3 (1.5s hold) = 3s + travel time. Tight but possible.
- Down to 1 player: need 4.5s of holds + travel in 5s window. Nearly impossible unless walls already squeezed arena small.

### Death spiral
Lose a player → can't press all buttons → walls squeeze → less room to dodge → easier to kill remaining players → game ends fast.

### Comeback mechanic (natural)
A squeezed arena means buttons are closer together. A solo survivor in a narrow corridor might actually clutch the button run — built-in tension without artificial comeback mechanics.

---

## Territorial Damage

- Crossing the midline into enemy territory drains HP slowly
- Creates risk/reward: push for a powerup or flank, but you're bleeding
- Healer can offset the drain if pushing with teammates
- Prevents permanent camping in enemy half

---

## Powerups

- Spawn at random intervals in neutral/contested zones
- Touch to pick up, tap special button to use
- One held at a time
- Examples: shield bubble, rapid fire, heal burst, bomb (AOE damage)
- Forces both teams to contest neutral ground

---

## Target Priority (every class matters)

- **Kill the healer** → team can't sustain through damage
- **Kill the shooter** → team loses the fastest player (best at solo button runs)
- **Kill the tank** → team loses their damage sponge and front line

No class is throwaway.

---

## Match Flow

1. Matchmaking pairs 6 players (or invite codes like private craps tables)
2. Server assigns classes (1 tank, 1 shooter, 1 healer per team)
3. 10-second fight cycles with 5-second button phases
4. Match ends when one team is eliminated or after 90 seconds (team with more surviving HP wins)

### Typical match timeline (45-90 seconds)
```
0-10s:  Fight at full width
10-15s: First buttons — both teams press, no squeeze
15-25s: Fight, someone gets a kill
25-30s: Buttons — losing team down to 2, can't press all 3, walls squeeze
30-40s: Fight in tighter space, another kill likely
40-45s: Buttons — 1 player left, walls squeeze again
45-50s: Last player trapped in narrow corridor, easy finish
```

---

## Technical Architecture

### Backend (reuse existing infrastructure)
- **Durable Object per arena** (same pattern as craps tables)
- Server-authoritative: DO tracks all positions, bullets, HP, powerups, walls
- WebSocket protocol: clients send inputs only, DO sends game state
- ~15-20 ticks per second game loop in the DO
- Session token HMAC verification (same as craps)
- Disconnect/reconnect grace period (same as craps)

### Client sends (inputs only)
```
{ type: 'input', up: bool, down: bool, left: bool, right: bool, shoot: bool, special: bool }
```

### Server sends (full state each tick)
```
{ type: 'state', players: [...], bullets: [...], powerups: [...], walls: {...}, buttons: [...], timer: ... }
```

### Anti-cheat
- Client only sends button presses — server does all movement, collision, damage
- Speed capped server-side per class
- Fire rate enforced server-side
- HP tracked server-side only
- No position data accepted from client

### Cost at scale
- 6 players × 20 ticks/sec × 90 seconds = ~10,800 DO requests per match
- 925 matches/month included in $5/month plan
- 50,000 matches/month ≈ $85/month
- Traditional game server for same load: $200-500/month

### Client-side prediction
- Client moves player immediately on input for responsive feel
- Server corrects if there's a discrepancy
- At 50-100ms Cloudflare edge latency, this makes movement feel instant

---

## Files needed
- `worker/arena.js` — Durable Object (game loop, state, collision)
- `worker/runner-worker.js` — Add arena routing endpoints
- `games/pvp.html` — Client renderer + controls
- `worker/wrangler.toml` — Add Arena DO binding
