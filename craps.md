# Craps — Architecture & Game Logic Reference

## Overview

Multiplayer craps where players wager **cells** (in-game currency tied to their Chad NFT). The system is:

- **`Gamble.sol`** — on-chain contract for cell wagers and oracle-signed payouts
- **`gamble.html`** — NPC hub where players select a Chad, set wager, buy in
- **`craps.html`** — multiplayer craps table (up to 4 players), server-authoritative dice
- **`runner-worker.js`** — Cloudflare Worker that verifies on-chain wagers, signs cashout payouts
- **`craps-table.js`** — Durable Object (DO) that owns all game state: bets, dice, shooter rotation

**Contract address:** `GAMBLE_ADDRESS` in `js/config.js`

---

## Player Flow (End-to-End)

```
gamble.html                     Blockchain                  Worker / DO
  │                                │                          │
  │  1. Connect wallet             │                          │
  │  2. Select Chad NFT            │                          │
  │  3. Set wager amount           │                          │
  │                                │                          │
  ├─ BUY IN ─────────────────────►│                          │
  │        commitWager(tokenId,    │                          │
  │          wagerAmount)          │                          │
  │        → spendCells(wager)     │                          │
  │        → emit WagerCommitted   │                          │
  │          (..., nonce)          │                          │
  │                                │                          │
  ├─ POST /craps/start ──────────────────────────────────────►│
  │  { tokenId, nonce, player }    │        Verify wager chain│
  │                                │        Generate session  │
  │◄──────────────────────── { ok, stack, sessionToken } ─────┤
  │                                │                          │
  │  4. Save to sessionStorage     │                          │
  │  5. Redirect → craps.html      │                          │
  │                                │                          │
craps.html                         │                          │
  │                                │                          │
  │  6. Gate check: craps_session  │                          │
  │     must exist in session-     │                          │
  │     Storage, else redirect     │                          │
  │     back to gamble.html        │                          │
  │                                │                          │
  │  7. Table lobby appears        │                          │
  │  8. Join public or private     │                          │
  │                                │                          │
  │  9. WebSocket connects ────────────────────────────────►  DO
  │     Auth message w/ nonce +    │                          │
  │     sessionToken               │                          │
  │                                │                          │
  │  10. Play (bet/roll cycles)    │                          │
  │                                │                          │
  │  11. CASH OUT ─────────────────────────────────────────► Worker
  │      POST /craps/cashout       │                          │
  │      { nonce, sessionToken,    │                          │
  │        tableCode }             │        DO returns payout │
  │                                │        Oracle signs it   │
  │◄──────────── { payout, nonce, signature } ────────────────┤
  │                                │                          │
  │  12. claimWinnings(tokenId, ──►│                          │
  │        payout, nonce, sig)     │                          │
  │      → cells credited on-chain │                          │
```

---

## Entry Gate

`craps.html` **requires** `craps_session` in `sessionStorage` (set by `gamble.html` during buy-in). If missing, the page immediately redirects to `gamble.html` and halts all script execution. This prevents direct URL access.

**Session data stored:**
```js
{
  nonce,          // from commitWager event
  tokenId,        // Chad NFT token ID
  chadName,       // character name
  stack,          // starting cells (= wager amount)
  sessionToken,   // HMAC-SHA256 token from Worker
  player,         // wallet address
  buyIn           // original wager amount
}
```

---

## Session Token (Anti-Cheat)

Generated server-side via HMAC-SHA256:
```
HMAC-SHA256(ORACLE_PRIVATE_KEY, "craps:{nonce}:{player}")
```

Verified by the DO on WebSocket `auth` message and by the Worker on `/craps/cashout`. Prevents players from spoofing other sessions.

---

## Table Architecture

### Durable Object (`CrapsTable` in `craps-table.js`)

Each table is a named DO instance. Public tables have fixed names (`public-1`, etc.). Private tables use `priv-{random6}`.

**Storage keys:**
| Key | Value |
|-----|-------|
| `game` | `{ phase, point, rolling, rollCount }` |
| `shooter` | `"{player}-{tokenId}"` (playerId string) |
| `player:{nonce}` | Full player state (see below) |

**Player data (`player:{nonce}`):**
```js
{
  tokenId,        // Chad NFT ID
  player,         // wallet address (lowercase)
  stack,          // current cell balance
  bets: {},       // active bets by zone
  comeBets: {},   // come bets on numbers { "6": 5, "8": 10 }
  comeOdds: {},   // come odds on numbers
  buyIn,          // original buy-in amount
  lastBetTime,    // Date.now() — updated on register + every bet
  _expectedToken  // session token for auth verification
}
```

### WebSocket Messages

**Client → DO:**
| Message | Purpose |
|---------|---------|
| `{ type: 'auth', nonce, sessionToken }` | Authenticate and join table |
| `{ type: 'bet', zone, amount }` | Place a bet |
| `{ type: 'clear-bets' }` | Remove all bets (returns cells to stack) |
| `{ type: 'roll' }` | Roll the dice (shooter only) |
| `{ type: 'press', zone }` | Double a winning standing bet |
| `{ type: 'pass-dice' }` | Voluntarily pass shooter role |
| `{ type: 'chat', text }` | Send chat message |
| `{ type: 'pong' }` | Heartbeat response |

**DO → Client:**
| Message | Purpose |
|---------|---------|
| `{ type: 'init', players, shooter, game }` | Full state on join |
| `{ type: 'auth-ok', seat, stack, phase, point }` | Auth confirmed |
| `{ type: 'bet-ok', stack, bets, comeBets, comeOdds }` | Bet accepted |
| `{ type: 'bet-rejected', reason }` | Bet denied |
| `{ type: 'state', playerId, name, chadId, bets, comeBets, stack }` | Player state broadcast |
| `{ type: 'rolling', playerId, name }` | Dice are being rolled |
| `{ type: 'roll-result', dice, total, phase, point, resolution, stack, bets, comeBets, pressOptions }` | Roll outcome |
| `{ type: 'shooter', playerId }` | New shooter assigned |
| `{ type: 'join', playerId, name, chadId, stack }` | Player joined |
| `{ type: 'leave', playerId }` | Player left |
| `{ type: 'chat', playerId, name, text }` | Chat message |
| `{ type: 'kick', reason }` | Player removed (idle, etc.) |
| `{ type: 'ping' }` | Heartbeat (every 30s) |
| `{ type: 'error', message }` | Error |
| `{ type: 'full' }` | Table is full (4 players max) |

### REST Endpoints (DO internal)
| Route | Method | Purpose |
|-------|--------|---------|
| `/info` | GET | Player count + max |
| `/register` | POST | Pre-register player data |
| `/cashout` | POST | Return player payout + remove from table |
| `/reset` | POST | Nuke all state (admin) |

---

## Game Phases

Two phases: **comeout** and **point**.

### Come-Out Roll
- **7 or 11:** Pass line wins (even money). Phase stays comeout.
- **2, 3, or 12:** Pass line loses (craps). Phase stays comeout.
- **4, 5, 6, 8, 9, 10:** That number becomes the **point**. Phase moves to point.

### Point Phase
- **Roll the point:** Pass line wins (even money). Phase resets to comeout.
- **Roll a 7:** Seven-out. Pass line loses. All place/hard/come bets on numbers lose. Shooter rotates. Phase resets to comeout.
- **Any other number:** Resolves place/come/hard/field bets. Point unchanged.

---

## Bet Types & Payouts

### Pass Line (`pass`)
- Comeout only. Wins on 7/11, loses on 2/3/12, otherwise establishes point.
- In point phase: wins when point is hit, loses on 7.
- **Payout:** 1:1 (even money)

### Pass Odds (`passOdds`)
- Point phase only. Backs the pass line bet with true odds.
- **Payout:** True odds — 4/10 pay 2:1, 5/9 pay 3:2, 6/8 pay 6:5

### Field (`field`)
- One-roll bet. Wins on 2, 3, 4, 9, 10, 11, 12.
- **Payout:** 1:1 normally, 2:1 on 2, 3:1 on 12. Lost on 5/6/7/8.

### Come (`come`)
- Point phase only. Works like a personal pass line.
- Wins immediately on 7/11, loses on 2/3/12.
- Otherwise moves to that number — wins when the number hits again, loses on 7.
- **Payout:** 1:1 (even money)

### Come Odds (`comeOdds{N}`)
- Backs a come bet sitting on number N. True odds payout.
- **Payout:** Same as pass odds (2:1, 3:2, 6:5 by number)

### Place Bets (`place4` through `place10`)
- Point phase only. **OFF during comeout** (not resolved).
- Wins when the number hits. Loses on 7.
- **Payout:** 4/10 pay 9:5, 5/9 pay 7:5, 6/8 pay 7:6

### Hardways (`hard4`, `hard6`, `hard8`, `hard10`)
- Point phase only. **OFF during comeout**.
- Wins when the number is rolled as a pair (e.g. hard 8 = 4+4). Loses on 7 or the number rolled "easy" (not a pair).
- **Payout:** Hard 4/10 pay 7:1, Hard 6/8 pay 9:1

---

## Dice & Rolling

### Server-Authoritative Rolls
All dice rolls happen server-side in the DO using `crypto.getRandomValues()`:
```js
const arr = new Uint32Array(2);
crypto.getRandomValues(arr);
const d1 = (arr[0] % 6) + 1;
const d2 = (arr[1] % 6) + 1;
```
The client never generates dice values. The DO broadcasts the result to all connected players.

### Roll Flow
1. Shooter sends `{ type: 'roll' }`
2. DO verifies shooter has at least one bet on the table
3. DO generates dice, calls `resolveBets()` for every player
4. DO broadcasts `roll-result` to all players with their individual resolution
5. Client animates dice and displays results

---

## Turn Timers

Timers use **`Date.now()` deadlines** (not interval counters) so they persist accurately when the browser tab is backgrounded. A backup `setTimeout` guarantees the callback fires even if `requestAnimationFrame` is paused. A `visibilitychange` listener catches up the UI instantly when the tab regains focus.

### Bet Timer
- **Multiplayer:** 20 seconds
- **Solo:** 15 seconds
- When timer expires:
  - If shooter has no pass line bet → dice pass to next player (shooter's client sends `pass-dice`)
  - If bets exist → bets lock, "NO MORE BETS" shown, roll phase begins after 1.5s

### Roll Timer
- **Multiplayer only:** 10 seconds to roll after bets lock
- When timer expires → `rollDice()` fires automatically
- Solo mode: no auto-roll timer, player clicks dice manually

---

## Shooter Rotation

- First player to join becomes shooter
- Shooter **must** bet on pass line to roll. If bet timer expires with no pass bet → dice pass automatically
- Shooter rotates on **seven-out** (rolled 7 during point phase)
- Shooter rotates when current shooter **disconnects** or is **kicked**
- Round-robin order based on player storage order
- Announcer always introduces new shooters: *"New shooter coming out! Let's see what ya got {name}"*

---

## Multiplayer

### Seats
- 4 seats max (seat 0 = local player, seats 1-3 = remote)
- Each player has their own stack, bets, and come bets
- All players' bets resolve on every roll (not just the shooter's)

### Player Identity
- `playerId` = `"{walletAddress}-{tokenId}"` (unique per Chad at table)
- Player names are their Chad NFT name

### Chat
- Color-coded by seat position (green, blue, purple, red)
- System messages for joins, leaves, wins

---

## Idle Kick (15 Minutes)

The DO alarm (runs every 30s) checks every player's `lastBetTime`. If a player hasn't placed a bet in **15 minutes**, they are kicked:

1. Player data is logged to `RUNNER_KV` before removal:
   ```
   Key:   kick:{timestamp}:{wallet}
   Value: { wallet, tokenId, cellsLost, stack, bets, reason, kickedAt }
   TTL:   90 days
   ```
2. Client receives `{ type: 'kick', reason }` → shows message for 3s → redirects to `gamble.html`
3. Player's cells on the table are **lost** (not recoverable automatically)

### Viewing Kick Logs (Admin)
```bash
curl -H "Authorization: Bearer YOUR_ORACLE_PRIVATE_KEY" \
  https://your-worker.dev/craps/kick-log
```
Returns `{ kicks: [...] }` sorted newest first. Use wallet address to identify players requesting refunds.

---

## Heartbeat & Zombie Detection

- DO sends `{ type: 'ping' }` every 30 seconds to all sockets
- Client responds with `{ type: 'pong' }`
- If no pong received for 60 seconds → socket closed as zombie → `_handleDisconnect` fires

---

## Leaving & Cash Out

### Cash Out (happy path)
1. Player clicks "Cash Out" button
2. Client sends `POST /craps/cashout` to Worker with `{ nonce, sessionToken, tableCode }`
3. Worker calls DO `/cashout` endpoint → DO returns total payout (stack + all bets on table)
4. Worker marks nonce as done in KV (`craps_done:{nonce}`, 24h TTL)
5. Worker signs payout with oracle wallet: `solidityPackedKeccak256([tokenId, payout, nonce, player])`
6. Client calls `Gamble.claimWinnings(tokenId, payout, nonce, signature)` on-chain
7. Cells credited to the player's Chad NFT

### Leave Without Cashing Out
- **Exit button (X):** Confirm dialog warns *"Leaving without cashing out means you LOSE all cells. Are you sure?"*
- **Nav menu links:** Same confirm dialog intercepts clicks when player has cells on table
- **Tab close / navigate away:** Browser `beforeunload` prompt: *"Cash out first or they will be lost."*
- **If they leave anyway:** Cells are lost. No recovery. No localStorage backup.

### Auto-Bust
When a player's stack hits 0 and they have no bets on the table, the client auto-cashes out (payout = 0) and redirects to gamble.html.

---

## Disconnect & Table Cleanup

When a player disconnects (WebSocket close/error):
1. Player data deleted from DO storage immediately
2. `leave` broadcast to remaining players
3. If disconnected player was shooter → next player in storage becomes shooter
4. If table is empty → `storage.deleteAll()` (full reset)

**Important:** Disconnecting without cashing out = cells lost. The DO deletes player data on disconnect. There is no recovery mechanism.

---

## Worker Endpoints

### `POST /craps/start`
**Body:** `{ tokenId, nonce, player }`
1. Verifies wager exists on-chain via `Gamble.wagerAmounts(nonce)`
2. Verifies player matches `Gamble.wagerPlayers(nonce)`
3. Checks nonce hasn't been used (`craps_done:{nonce}` KV key)
4. Generates HMAC session token
5. Returns `{ ok, stack, sessionToken }`

### `POST /craps/cashout`
**Body:** `{ tokenId, nonce, sessionToken, tableCode }`
1. Checks nonce not already cashed out
2. Calls DO `/cashout` → gets payout amount
3. Marks nonce done in KV
4. Signs payout with oracle wallet
5. Returns `{ ok, payout, nonce, signature }`

### `GET /craps/kick-log`
**Auth:** `Authorization: Bearer {ORACLE_PRIVATE_KEY}`
Returns all kick log entries from KV, sorted newest first.

### `GET /tables/list`
Returns public table info (player counts, capacity). Used by lobby to show available tables.

### `POST /tables/reset-all`
**Auth:** `Authorization: Bearer {ORACLE_PRIVATE_KEY}`
Resets all public table DOs. Admin emergency use only.

---

## Configuration

### Cloudflare Secrets (set via `wrangler secret put`)
- `ORACLE_PRIVATE_KEY` — hex private key for signing payouts + HMAC tokens
- `AGORA_APP_CERT` — Agora certificate (optional, for voice/video)

### wrangler.toml Vars
- `GAMBLE_ADDRESS` — Gamble.sol contract address
- `LASTCHAD_ADDRESS` — LastChad.sol contract address
- `READ_RPC` — Avalanche RPC URL for on-chain reads
- `GAME_BASE_URL` — e.g. `https://lastchad.xyz`

### Deploy
```bash
# From GitHub Actions:
# Repo → Actions → "Deploy Worker" → Run workflow → select branch → Run
# (Requires: CF_API_TOKEN, CF_ACCOUNT_ID, ORACLE_PRIVATE_KEY secrets)
```

**After deploying worker changes, a table reset may be needed** if existing DOs have stale player data from before the deploy. Use the reset workflow or call `/tables/reset-all`.

---

## Key Files

| File | Purpose |
|------|---------|
| `gamble.html` | NPC hub: wallet connect, Chad select, wager, buy-in |
| `craps.html` | Multiplayer craps table UI (client) |
| `worker/craps-table.js` | Durable Object: all game state, bets, dice, resolution |
| `worker/runner-worker.js` | Worker router: on-chain verification, cashout signing, kick logs |
| `worker/wrangler.toml` | Cloudflare Worker config |
| `js/config.js` | Contract addresses, ABIs, RPC URLs |
| `Gamble.sol` | On-chain wager escrow + oracle payout verification |
