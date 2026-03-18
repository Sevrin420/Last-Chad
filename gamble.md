# Gamble System — Architecture Reference

## Overview

The gambling system lets players wager **cells** (in-game currency tied to their Chad NFT) on casino games. It consists of:

- **`Gamble.sol`** — on-chain contract for cell wagers and oracle-signed payouts
- **`gamble.html`** — NPC-driven hub where players select games, choose a Chad, and buy in
- **`craps.html`** — multiplayer craps table with Agora video/audio, server-authoritative dice
- **Cloudflare Worker** (`runner-worker.js`) — server-side game logic, anti-cheat, payout signing

**Contract address:** `GAMBLE_ADDRESS` in `js/config.js`

---

## Player Flow (End-to-End)

```
gamble.html                     Blockchain                  Worker
  │                                │                          │
  │  1. Connect wallet             │                          │
  │  2. Select Chad NFT            │                          │
  │  3. Choose game (Craps)        │                          │
  │  4. Set wager amount           │                          │
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
  │                                │        Create KV session │
  │◄──────────────────────── { ok, stack, sessionToken } ─────┤
  │                                │                          │
  │  5. Save to sessionStorage     │                          │
  │  6. Redirect → craps.html      │                          │
  │                                │                          │
craps.html                         │                          │
  │                                │                          │
  │  7. Table lobby appears        │                          │
  │     (shows public table        │                          │
  │      player counts)            │                          │
  │  8. Join public or private     │                          │
  │                                │                          │
  │  9. Fetch Agora RTC token ────────────────────────────────►│
  │     POST /agora/token          │                          │
  │◄──────────────────────────────────────────── { token } ───┤
  │                                │                          │
  │  10. Join Agora channel        │                          │
  │      (video + push-to-talk)    │                          │
  │                                │                          │
  │  11. Place bets on felt        │                          │
  │  12. Roll dice ────────────────────────────────────────────►│
  │      POST /craps/roll          │        Validate bets     │
  │      { nonce, newBets,         │        Roll server-side   │
  │        sessionToken }          │        Resolve all bets   │
  │◄──── { dice, resolution, stack, phase, bets } ────────────┤
  │                                │                          │
  │  ... repeats many times ...    │                          │
  │                                │                          │
  │  13. Cash out ─────────────────────────────────────────────►│
  │      POST /craps/cashout       │        Return bets       │
  │      { tokenId, nonce,         │        Sign payout       │
  │        sessionToken }          │                          │
  │◄──────────────── { payout, nonce, signature } ────────────┤
  │                                │                          │
  │  14. (if payout > 0)           │                          │
  ├─ CLAIM ──────────────────────►│                          │
  │    claimWinnings(tokenId,      │                          │
  │      payout, nonce, oracleSig) │                          │
  │    → awardCells(tokenId,       │                          │
  │        payout)                 │                          │
  │    → emit WinningsClaimed      │                          │
```

---

## Connection & Session Architecture

### Session Data (sessionStorage)

When `gamble.html` completes the buy-in, it stores session data and redirects:

```js
sessionStorage.setItem('craps_session', JSON.stringify({
  nonce,          // from commitWager tx event
  tokenId,        // selected Chad NFT
  stack,          // initial chip count (from worker /craps/start)
  sessionToken,   // HMAC anti-cheat token (from worker)
  player,         // wallet address
  buyIn,          // original wager amount
}));
window.location.href = 'craps.html';
```

`craps.html` reads this on load. If no session exists, the roll button is disabled and a warning is shown.

### Agora RTC (Multiplayer Video/Audio)

Players see and hear each other at the craps table via Agora RTC SDK.

**Token flow (secured mode):**
1. Client sends `POST /agora/token { channelName, uid }` to the worker
2. Worker generates an AccessToken v006 using `AGORA_APP_ID` + `AGORA_APP_CERT` (secrets)
3. Client calls `agoraClient.join(appId, channel, token, uid)` with the returned token
4. Token expires after 1 hour; re-fetch on reconnect

**Worker secrets required:**
- `AGORA_APP_ID` — Agora project App ID
- `AGORA_APP_CERT` — Agora project App Certificate (enables secured token mode)

**Features:**
- Camera toggle (on/off)
- Push-to-talk audio (hold button)
- Up to 4 players per table (1 local + 3 remote seats)
- Text chat overlay

### Table Presence Tracking

The lobby shows live player counts for public tables.

**Endpoints:**
- `POST /tables/join { table, playerId }` — register presence (KV entry with TTL)
- `POST /tables/leave { table, playerId }` — remove presence
- `GET /tables/list` — returns all public tables with active player counts

**Client behavior:**
- Lobby polls `/tables/list` every 10 seconds while visible
- After joining, client sends heartbeat every 30 seconds via `/tables/join`
- On page unload, `navigator.sendBeacon` calls `/tables/leave`
- KV entries auto-expire after 120s if no heartbeat (stale threshold: 90s)

---

## Worker Endpoints (runner-worker.js)

### Craps

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/craps/start` | `{ tokenId, nonce, player }` | Verify wager on-chain, create KV session |
| POST | `/craps/bet` | `{ nonce, zone, amount, sessionToken }` | Place a single bet (validated server-side) |
| POST | `/craps/roll` | `{ nonce, newBets, sessionToken }` | Place new bets + roll dice + resolve all bets |
| POST | `/craps/cashout` | `{ tokenId, nonce, sessionToken }` | Return all bets to stack, sign payout |

**Session KV key:** `craps:{nonce}` (TTL: 20 minutes, refreshed on every interaction)

**Anti-cheat sessionToken:** HMAC-SHA256 of `craps:{nonce}:{player}` using `ORACLE_PRIVATE_KEY`. Generated at `/craps/start`, required on all subsequent calls. Prevents session hijacking.

**Dice:** Generated server-side with `crypto.getRandomValues()`. Client never controls dice outcomes.

**Bet resolution:** All bet math runs on the Worker. The client displays results but cannot alter the stack.

### Poker

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/poker/start` | `{ tokenId, nonce, player }` | Verify wager, create session with stack |
| POST | `/poker/deal` | `{ nonce, handWager, sessionToken }` | Deal 5 cards from fresh deck |
| POST | `/poker/draw` | `{ nonce, held: [5 bools], sessionToken }` | Replace unheld, evaluate hand, adjust stack |
| POST | `/poker/cashout` | `{ tokenId, nonce, sessionToken }` | Sign final payout |

**Session KV key:** `poker:{nonce}` (TTL: 10 minutes)

### Table Presence

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/tables/join` | `{ table, playerId }` | Register/heartbeat presence |
| POST | `/tables/leave` | `{ table, playerId }` | Remove presence |
| GET | `/tables/list` | — | List public tables with player counts |

### Agora Token

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| POST | `/agora/token` | `{ channelName, uid }` | Generate Agora RTC AccessToken v006 |

---

## Gamble.sol — Contract Interface

### Two-Transaction Settlement

Games that run over multiple rounds (poker, craps) use a two-tx flow:

1. **TX 1 — `commitWager(tokenId, wager)`** — cells are spent immediately, returns a `nonce`
2. **(Off-chain game plays out via Worker)**
3. **TX 2 — `claimWinnings(tokenId, payout, nonce, oracleSig)`** — oracle-signed payout awarded

If `payout == 0`, TX 2 is skipped (cells already gone from TX 1).

### Single-Transaction Settlement

Simple games (coin flip) resolve in one tx:

- **`flip(tokenId, wager)`** — 40% win chance, 2x payout, fully on-chain

### Oracle Signature Format

```
keccak256(abi.encodePacked(tokenId, payout, nonce, playerAddress))
```

Signed with EIP-191 (`eth_sign`) using `ORACLE_PRIVATE_KEY`.

### Wager Limits

| Variable | Default | Set via |
|----------|---------|---------|
| `minWager` | 1 | `setWagerLimits(min, max)` |
| `maxWager` | 50 | `setWagerLimits(min, max)` |

---

## Craps — Bet Types & Payouts

### Multi-Roll Bets

| Bet | When Placed | Wins | Loses | Payout |
|-----|-------------|------|-------|--------|
| Pass Line | Come-out only | 7/11 come-out, or hit point | 2/3/12 come-out, or 7 after point | 1:1 |
| Pass Odds | After point set | Hit point | 7-out | True odds |
| Come | After point set | 7/11 on next roll, or hit come-point | 2/3/12, or 7 after come-point | 1:1 |
| Place 4/10 | After point set | Number before 7 | 7 | 9:5 |
| Place 5/9 | After point set | Number before 7 | 7 | 7:5 |
| Place 6/8 | After point set | Number before 7 | 7 | 7:6 |
| Hard 4/10 | Any time | Hard way before 7 or easy | 7 or easy way | 7:1 |
| Hard 6/8 | Any time | Hard way before 7 or easy | 7 or easy way | 9:1 |

### One-Roll Bets

| Bet | Wins | Payout |
|-----|------|--------|
| Field | 2,3,4,9,10,11,12 | 1:1 (2 pays 2:1, 12 pays 3:1) |

### True Odds (behind Pass/Come)

| Point | Payout |
|-------|--------|
| 4/10 | 2:1 |
| 5/9 | 3:2 |
| 6/8 | 6:5 |

---

## Poker — Payout Table (Jacks or Better)

| Hand | Multiplier |
|------|-----------|
| Royal Flush | 250x |
| Straight Flush | 50x |
| Four of a Kind | 25x |
| Full House | 9x |
| Flush | 6x |
| Straight | 4x |
| Three of a Kind | 3x |
| Two Pair | 2x |
| Jacks or Better | 1x |
| No win | 0x |

---

## Frontend Files

| File | Purpose |
|------|---------|
| `gamble.html` | NPC hub — game selection, Chad selection, wager, buy-in (commitWager). Redirects to game page. |
| `craps.html` | Multiplayer craps table — lobby, Agora video/audio, server-authoritative gameplay |

---

## Worker Secrets & Config

**Cloudflare Worker secrets** (`wrangler secret put`):
- `ORACLE_PRIVATE_KEY` — hex private key for signing payouts
- `AGORA_APP_CERT` — Agora App Certificate for RTC token generation

**wrangler.toml vars:**
- `GAMBLE_ADDRESS` — Gamble.sol contract address
- `READ_RPC` — Avalanche RPC URL
- `AGORA_APP_ID` — Agora App ID

---

## Deployment

```bash
# Deploy Gamble.sol
npx hardhat run scripts/deployGamble.js --network fuji

# Deploy Worker
cd worker && npx wrangler deploy

# Set Agora secrets (one-time)
cd worker
wrangler secret put AGORA_APP_CERT
```

After deploying Gamble.sol:
1. `lastChad.setGameContract(gambleAddress, true)` — authorize cell spending
2. `gamble.setOracle(ORACLE_ADDRESS)` — set oracle for signature verification
3. Update `GAMBLE_ADDRESS` in `js/config.js` and `wrangler.toml`
