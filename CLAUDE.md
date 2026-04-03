# CLAUDE.md — Last Chad

---

## !!!!! CRITICAL: CONTRACT DEPLOYMENT !!!!!

**NEVER run scripts that deploy contracts. NEVER. Always ASK the user before deploying ANY contract. The user must explicitly confirm before any deploy script is executed. This includes testnet (Fuji) and mainnet. No exceptions.**

---

## User Context

The Claude user **cannot code or run code locally**. All scripts, deployments, and commands must be:
1. Written into a script file by Claude
2. Committed to the repo
3. Executed via a **GitHub Actions workflow**

Never tell the user to "run this command" — put it in a workflow and push it.

## Pushing Changes

All changes must be pushed **directly to `main`**. Do NOT sync via the create-main.yml workflow — it overwrites main with a force push and will delete any images or files the user has uploaded directly to main.

Use: `git push -u origin main`

---

## Working Rules

- Work in small, atomic steps: one file, one function, one fix per response.
- Do NOT rewrite large sections or refactor unrelated code unless asked.
- If unclear, ask ONE precise question instead of guessing.
- Keep responses short and focused.

### Off-Limits Files
- **`quest.html`** — Do NOT touch unless explicitly told to.
- **`quests/*/index.html`** — NEVER modify. Generated output from `github-api.js` + `quest-builder.html`.

---

## Project Overview

**Last Chad** is a multiplayer Web3 RPG with NFT characters, quests, and cell-wagering casino games on Avalanche. Hosted on GitHub Pages at lastchad.xyz.

### Elevator Pitch

Last Chad is a **skill-filtered yield tournament**. 15 weeks of RPG gameplay eliminates unskilled Chads. Survivors enter an *ongoing bi-weekly craps tournament*. Your endgame level determines your chips each round. Lock 1111 chips to claim a share of **prize money**. _The better you played, the more you earn forever._

**Tech Stack:** Hardhat v2.28.5, Solidity v0.8.26, OpenZeppelin v5.0.0, Web3.js + WalletConnect, Cloudflare Workers + Durable Objects.

---

## Smart Contracts (5 total, in `/contracts`)

| Contract | Purpose |
|----------|---------|
| `LastChad.sol` | ERC-721 NFT characters (70 max, 0.02 AVAX, 4 stats, XP/leveling, cells) |
| `LastChadItems.sol` | ERC-1155 items (stackable/non-stackable, dynamic creation) |
| `QuestRewards.sol` | Quest sessions, oracle-signed rewards, arcade death/survival |
| `Gamble.sol` | Cell wagering: commitWager/claimWinnings (craps), flip (coin), resolveGame (oracle) |
| `Market.sol` | Player-to-player NFT trading |

**Authorization chain:** Owner must call `setGameContract(address, true)` on LastChad and LastChadItems to authorize QuestRewards and Gamble.

**Deployed (Fuji testnet):**
- LastChad: `0x04DFED6F15866125b1f6d140bcb1AB90F7614252`
- QuestRewards: `0x1f3A741A5169B002C8F7563C7cD11a3081cD1E4B`
- Gamble: `0x42Ae979c86cF4868F8648A1eec16567CbBF19698`

---

## Player Lifecycle

```
1. MINT       mint.html     → LastChad.mint()              → ERC-721 token
2. SETUP      mint.html     → LastChad.setStats()           → name + 2 stat points
3. QUEST      quests/*/     → QuestRewards.startQuest()     → deterministic dice, oracle rewards
4. GAMBLE     gamble.html   → Gamble.commitWager()          → buy-in cells for craps table
5. CRAPS      craps.html    → WebSocket to Durable Object   → multiplayer craps
6. CASHOUT    craps.html    → Gamble.claimWinnings()        → oracle-signed payout
7. LEVEL UP   stats.html    → LastChad.spendStatPoint()     → assign stat points
```

---

## Craps System (Complete Architecture)

### Overview
Multiplayer craps (up to 4 players per table) using Cloudflare Workers + Durable Objects. Server-authoritative dice, HMAC anti-cheat, oracle-signed settlements.

### Entry Flow
1. Player selects chad on `gamble.html`, chooses cell wager amount
2. `Gamble.commitWager(tokenId, wager)` burns cells on-chain, returns nonce
3. Worker `POST /craps/start` verifies on-chain, generates HMAC session token
4. Player redirected to `craps.html` with session data in `sessionStorage`

### Durable Object (DO) — `craps-table.js`
The DO is the **single source of truth** for all game state. One DO instance per table.

**What the DO manages:**
- Game phase (`comeout` or `point`), established point number
- Per-player state: stack, bets, come bets, come odds, buy-in
- Shooter rotation (first joiner → rotates on seven-out or disconnect)
- Dice rolling via `crypto.getRandomValues()` (server-authoritative, not client)
- Bet validation and payout resolution on every roll
- Idle kick (15 min inactivity → cells lost, logged to KV for 90 days)
- Turn timers: 20s bet timer (15s solo), 10s roll timer (multiplayer)
- 30s heartbeat ping/pong, 60s timeout = zombie disconnect

**DO storage keys:**
```
game: { phase, point, rolling, rollCount }
shooter: "{player}-{tokenId}"
player:{nonce}: { tokenId, player, stack, bets, comeBets, comeOdds, buyIn, lastBetTime }
```

### WebSocket Protocol (craps.html ↔ DO)

**Client → DO:**
- `auth` — authenticate with nonce, sessionToken, player, tokenId, stack, buyIn
- `bet` — place bet (zone + amount)
- `roll` — roll dice (shooter only)
- `clear-bets` / `press` / `pass-dice` / `chat` / `pong`

**DO → Client:**
- `auth-ok` — seat assigned, game state sent
- `bet-ok` — bet accepted, updated stack/bets
- `roll-result` — dice values, resolution, updated stacks, press options
- `shooter` — new shooter announced
- `join` / `leave` / `chat` / `kick` / `full` / `ping`

### Bet Types & Payouts
| Bet | Payout | Notes |
|-----|--------|-------|
| Pass Line | 1:1 | Wins 7/11 comeout, loses 2/3/12, establishes point |
| Pass Odds | True odds | 2:1 on 4/10, 3:2 on 5/9, 6:5 on 6/8 |
| Field | 1:1 (2:1 on 2, 3:1 on 12) | Loses on 5/6/7/8 |
| Come | 1:1 | Personal pass line during point phase |
| Come Odds | True odds | On established come bets |
| Place 4/10 | 9:5 | OFF during comeout |
| Place 5/9 | 7:5 | OFF during comeout |
| Place 6/8 | 7:6 | OFF during comeout |
| Hardways | 7:1 (4/10), 9:1 (6/8) | OFF during comeout |

### Cash Out Flow
1. Player clicks "Cash Out" on `craps.html`
2. `POST /craps/cashout` → Worker calls DO `/cashout` → returns total payout (stack + remaining bets)
3. Worker signs `keccak256(tokenId, payout, nonce, player)` with oracle key
4. Client calls `Gamble.claimWinnings(tokenId, payout, nonce, signature)` on-chain
5. Cells credited. Nonce marked used (24h KV cache) to prevent replay.

**If player leaves without cashing out → cells are LOST.** `beforeunload` warning displayed.

### Anti-Cheat
- HMAC session token: `HMAC-SHA256(ORACLE_KEY, "craps:{nonce}:{player}")`
- Verified on WebSocket auth AND cashout
- Server-authoritative dice (DO uses `crypto.getRandomValues()`, never client-side)
- On-chain nonce prevents replay of oracle signatures

---

## Cloudflare Worker Backend (`worker/`)

| File | Purpose |
|------|---------|
| `runner-worker.js` | HTTP router: craps start/cashout, quest oracle, table list |
| `craps-table.js` | Durable Object: game state, WebSocket, dice, payouts |
| `wrangler.toml` | Config: bindings, KV, contract addresses, RPC URL |

**Key endpoints:**
```
POST /craps/start         — verify wager, generate session token
POST /craps/cashout       — sign payout, mark nonce used
GET  /tables/list         — public table info
WS   /craps/ws            — connect to DO table instance
POST /session/start|die|win — quest oracle endpoints
```

---

## Quest System (Brief)

- `startQuest()` → on-chain keccak256 seed → deterministic dice rolls
- `completeQuest()` → oracle-signed cell reward (sectionCells + diceCargo + statBonus)
- 1-hour session timeout, 30-day cooldown per quest
- Quest pages generated by `quest-builder.html` → `github-api.js` → `quests/{slug}/index.html`
- All quest template changes go in `github-api.js` only

---

## Going Live Plan

See **`plan.md`** for the complete mainnet deployment plan. Covers:
- LastChad.sol level freeze modification
- New Tournament.sol contract (monthly craps tournament, cell airdrops, yield distribution)
- All files that need address/network updates (Fuji → Avalanche C-Chain)
- Deploy workflow, tournament payout workflow, endgame activation workflow
- Full checklist for going live

**Read `plan.md` before working on any mainnet transition or tournament features.**

---

## Common Commands

```bash
npm test                              # Full test suite
npx hardhat compile                   # Compile contracts
npx hardhat test --grep "keyword"     # Specific tests
```

## Networks

| Network | Purpose |
|---------|---------|
| Avalanche Mainnet | Production |
| Fuji Testnet | Testing & deployment staging |
