# Experience Logic — Last Chad

## Overview

Experience (XP) is earned at the end of each quest. It is calculated from three sources:

```
finalXP = sectionXpTotal + diceXP + statBonus
```

All three components are computed or verified server-side by the Cloudflare Worker before any on-chain award is made. The player's client can report the dice score, but cannot inflate section XP or stat bonuses.

---

## XP Sources

### 1. Section XP (`sectionXpTotal`)
- Every quest section can have a fixed XP value set in the quest builder (default 0)
- When a player **enters** a section, the quest page POSTs to `/session/visit-section`
- The Worker records the visit in KV: `visitedSections[sectionId] = xp`
- **First-visit-only** — revisiting a section never adds XP twice
- At claim time, the Worker sums all visited section XP values: `sectionXpTotal = Σ visitedSections[*]`

### 2. Dice XP (`diceXP`)
- Earned from the Ship Captain Crew dice minigame inside a dice section
- Rules: must roll 6 (SHIP) + 5 (CAPTAIN) + 4 (MATE) among kept dice
- If all three are present: `diceXP = sum of remaining 2 dice (range 2–12)`
- If any are missing: `diceXP = 0`
- The cargo score (0–12) is computed client-side from the on-chain seed and reported to the Worker as `diceXP` in the `/session/win` call
- The Worker caps this at 12

### 3. Stat Bonus (`statBonus`)
- Some dice sections are configured with a stat bonus (STR / INT / DEX / CHA)
- The Worker reads the quest's `data.json` to find which stat applies (never trusting the client)
- The Worker calls `LastChad.getStats(tokenId)` on-chain to get the stat's current value
- `statBonus = value of that stat` (e.g. 3 DEX = +3 XP)
- Cached in KV for 24h per questId

### Hard Cap
- `finalXP` is capped at **50** in the Worker regardless of individual component totals

---

## One-Attempt Rule

Each Chad NFT can only start each quest **once, ever**.

### On-chain enforcement
- `QuestRewards.startQuest(tokenId, questId)` sets `questStarted[tokenId][questId] = true` permanently
- This is checked in `adventure.html` before calling `startQuest()` — if already attempted, the BEGIN QUEST button shows an error and navigation is blocked

### Worker enforcement (KV)
- When `/session/start` is called, the Worker queries `QuestRewards.questStarted(tokenId, questId)` on-chain
- If the KV session already has `completed: true`, the start request is rejected: `{ ok: false, reason: 'quest_already_completed' }`
- If the KV session has `died: true`, the start request is rejected: `{ ok: false, reason: 'already_died' }`
- Normal re-registration is allowed (covers the case where `adventure.html` starts the quest and then the player loads the quest page, which calls `/session/start` again)

### Quest page enforcement (intro overlay)
- Before showing the START button, the generated quest checks `QuestRewards.lockedBy(tokenId)` on-chain
- If the NFT is not in escrow (not locked), START is disabled and a **🔒 LOCK CHAD IN ESCROW** button is shown
- `lockChadInEscrow()` handles: approve NFT transfer → call `QuestRewards.startQuest()` → on success, enable START
- `checkEscrowStatus()` is called on page load and after wallet connect

---

## Cloudflare Worker API

**Base URL:** configured per deployment in quest builder (Worker URL field)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/session/start` | `{ tokenId, questId, player }` | Register session start; checks one-attempt rule |
| POST | `/session/die` | `{ tokenId, questId }` | Record death; marks session as died |
| POST | `/session/visit-section` | `{ tokenId, questId, sectionId, sectionXp }` | Record section visit + XP; first-visit only |
| POST | `/session/win` | `{ tokenId, questId, diceXP }` | Finalise XP, sign result, mark completed |
| GET | `/session/status` | `?tokenId=&questId=` | Query current session state |

### `/session/win` response
```json
{
  "ok": true,
  "signature": "0x...",
  "xpAmount": 24,
  "sectionXpTotal": 15,
  "dice": 6,
  "statBonus": "dexterity",
  "statValue": 3,
  "elapsed": 145000
}
```
The `signature` is `keccak256(tokenId, questId, player, finalXP)` signed by the oracle wallet. Future `QuestRewards.sol` upgrades can verify this on-chain via `ecrecover`.

---

## KV Session Structure

Key: `runner:{tokenId}:{questId}` — TTL: 1 hour (3600s) during quest; 24h after win

```json
{
  "runStartedAt": 1712345678901,
  "died": false,
  "completed": false,
  "player": "0xabc123...",
  "visitedSections": {
    "1712345001": 10,
    "1712345002": 5
  },
  "diceScore": null
}
```

After `/session/win`, `completed` is set to `true` and `diceScore` is recorded.

---

## Quest Builder — Per-Section XP

In `quest-builder.html`, each section has a **⭐ Section XP (awarded at quest end)** number input:
- Default: `0`
- Range: `0–50`
- Value is saved to `section.sectionXp` in state and localStorage
- Published to the generated quest's `sectionXpMap` at build time

**Image upload is hidden for dice sections** — when "Roll Dice → 0–12 XP" is selected as the action type, the photo upload field is hidden automatically (dice sections use the HUD instead of a section image).

---

## Generated Quest — Runtime Flow

1. Player arrives at quest page (from `adventure.html`, which already called `QuestRewards.startQuest()`)
2. Intro overlay checks escrow status (`lockedBy`) — START enabled only if NFT is locked
3. Player clicks START → quest begins, `/session/start` called on Worker
4. As player moves through sections, each `goToSection(id)` call fires `/session/visit-section` for any section with `sectionXp > 0`
5. Player completes dice roll → score stored locally in `diceState[sid].totalScore`
6. Player reaches completion panel → clicks CLAIM XP
7. Quest page calls `/session/win` with `diceXP` → Worker returns `{ signature, xpAmount }`
8. Quest page calls `QuestRewards.completeQuest(...)` on-chain with the signed XP amount
9. `markQuestDone(chadId)` records completion locally; level-up check runs

---

## Runner Game (runner.html) — Anti-Cheat

The embedded runner game integrates with the Worker for session tracking:

- URL params passed to iframe: `?tokenId=&questId=&player=&worker=`
- `startGame()` → POST `/session/start`
- Each death → POST `/session/die`
- On win → POST `/session/win` with `diceXP: 0` (runner has no dice)
  - Worker returns signed cert
  - `window.parent.postMessage({ type: 'runner_win', cert }, '*')` sent to parent quest page
  - Parent advances to next section via `goToSection(nextSectionId)`
- On all lives exhausted (game_over):
  - HTML overlay shows: mainbg.png background + dialogue.jpg border + **"You have died"**
  - 3-second hold → 1-second fade → redirect to `index.html`
- `WIN_THRESHOLD_MS = 110,000ms` — Worker rejects wins submitted faster than ~2 minutes (prevents speed-hack)

---

## Death Behaviour

Death is **rare and quest-specific**. The default outcome of running out of lives in runner.html is the death screen → redirect to `index.html`. Whether the Chad NFT is burned or released after death is determined per-quest by the game owner calling:

- `QuestRewards.burnLocked(tokenId)` — permanent burn to `0x000...dEaD`
- `QuestRewards.releaseLocked(tokenId)` — mercy release back to player

If the player does **not** die, `QuestRewards.completeQuest(tokenId, questId, xp > 0)` returns the NFT from escrow and awards XP in the same transaction.

---

## Configuration

### worker/wrangler.toml vars
```toml
LASTCHAD_ADDRESS      = "0x27732900f9a87ced6a2ec5ce890d7ff58f882f76"
QUEST_REWARDS_ADDRESS = "0x24e80b24aecd3e4230f294c932fb5e63b6bd3650"
READ_RPC              = "https://api.avax-test.network/ext/bc/C/rpc"
GAME_BASE_URL         = "https://lastchad.xyz"
```

### Secrets (set via `wrangler secret put`)
- `ORACLE_PRIVATE_KEY` — hex private key (no 0x) used to sign XP amounts

### Quest builder publish settings
- `QUEST_REWARDS_ADDRESS` — hardcoded in `quest-builder.html` publish block
- `WORKER_URL` — entered in the **⚙️ Worker URL** field before publishing; embedded in generated quest as `WORKER_URL` constant
