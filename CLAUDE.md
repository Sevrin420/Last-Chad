# CLAUDE.md — Members Only

---

## !!!!! CRITICAL: CONTRACT DEPLOYMENT !!!!!

**NEVER run scripts that deploy contracts. NEVER. Always ASK the user before deploying ANY contract. The user must explicitly confirm before any deploy script is executed. This includes testnet (Fuji) and mainnet. No exceptions.**

---

## !!!!! SECURITY: CONTENT SECURITY POLICY !!!!!

**Every new HTML page MUST include this CSP meta tag immediately after `<meta charset>`:**

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self' https://api.avax.network https://rpc.ankr.com https://last-chad-runner.severin20.workers.dev https://cloud.walletconnect.com wss://relay.walletconnect.com wss://relay.walletconnect.org https://*.walletconnect.org https://*.walletconnect.com https://api.web3modal.org; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://fonts.reown.com; frame-src https://verify.walletconnect.com;">
```

This blocks malicious scripts from injecting bad transactions. Already added to all existing pages. No exceptions for new pages.

Note: `frame-src https://verify.walletconnect.com` (not `'none'`) — WalletConnect v2 requires this iframe for dApp session verification. Without it, WalletConnect sessions can become unstable and transactions fail.

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
- **`assets/`** — Do NOT touch NFT images or asset folders.
- **`metadata/`** — NEVER modify. NFT metadata is set and immutable.
- **`chads/`** — NFT artwork, do not modify.

---

## Project Overview

**Members Only** is an NFT-gated casino on Avalanche. 222 Chad NFTs grant access to multiplayer craps, poker, tournaments, and a player-to-player market. Hosted on GitHub Pages at lastchad.xyz.

### Elevator Pitch

Members Only is a **pure casino**. Mint a Chad, earn chips weekly (based on your Tier and Level), and spend them at the tables. Top chip holders dominate the leaderboard. Tournaments let players compete for prizes by locking their chip stacks as scores.

**Tech Stack:** Hardhat v2.28.5, Solidity v0.8.26, OpenZeppelin v5.0.0, ethers.js v5 + AppKit/Reown, Cloudflare Workers + Durable Objects.

---

## Smart Contracts (6 total, in `/contracts`)

| Contract | Purpose |
|----------|---------|
| `MembersOnly.sol` | ERC-721 NFT (222 max, 0.01 AVAX, chips, tiers, levels, weekly claims, partner bonus, Merkle whitelist) |
| `MembersOnlyItems.sol` | ERC-1155 items (stackable/non-stackable, utilize/lock, wallet-claimable) |
| `Gamble.sol` | Chip wagering: commitWager/claimWinnings (craps), flip (coin), resolveGame (oracle) |
| `Market.sol` | Player-to-player NFT trading |
| `Tournament.sol` | Tournament system: enter, lock score, rebuy, leaderboard |
| `Treasury.sol` | Yield vault: burn 10k chips/share, owner deposits AVAX monthly, shareholders claim proportional yield |

**Authorization chain:** Owner must call `setGameContract(address, true)` on MembersOnly to authorize Gamble, Tournament, and Treasury.

**Key constants:**
- `MAX_SUPPLY`: 222
- `MINT_PRICE`: 0.01 AVAX
- `MAX_MINT_PER_WALLET`: 5
- Level by mint order: #1-50=L1, #51-100=L2, #101-150=L3, #151-222=L4
- Tiers (1-3) set by owner to match metadata traits

---

## Player Lifecycle

```
1. MINT         mint.html   → MembersOnly.mint()              → ERC-721 token
2. SETUP        mint.html   → MembersOnly.setName()           → name (12 char max)
3. WEEKLY CLAIM mint.html   → MembersOnly.claimWeeklyChips()  → tier + level chip reward
4. GAMBLE       gamble.html → Gamble.commitWager()            → buy-in chips for craps
5. CRAPS        craps.html  → WebSocket to Durable Object     → multiplayer craps
6. CASHOUT      craps.html  → Gamble.claimWinnings()          → oracle-signed payout
7. TOURNAMENT   tournament.html → Tournament.enterTournament() → compete for prizes
8. TREASURY     treasury.html → Treasury.burnForShares()      → burn 10k chips per yield share
```

---

## Chip System

- **Chips** = on-chain balance on each NFT (`_chips` mapping in MembersOnly.sol)
- **Weekly claim**: `claimWeeklyChips(tokenId)` → awards `tierChipReward[tier] + levelBonusChips[level]`
- **Spend**: Gamble/Tournament call `spendChips(tokenId, amount)` via authorized game contract
- **Award**: `awardChips(tokenId, amount)` / `batchAwardChips([]tokenIds, []amounts)`
- Leaderboard ranks by total chip count

---

## Treasury (Yield Vault)

- Players burn **10,000 chips per share** via `Treasury.burnForShares(tokenId, numShares)` — permanent, chips are gone
- Burn 20,000 = 2 shares, 30,000 = 3 shares, etc.
- Owner deposits AVAX monthly via `depositYield()` — snapshots total shares at that moment
- Shareholders claim proportional yield: `claimYield(tokenId, month)` or `batchClaimYield(tokenId, months[])`
- Uses per-token checkpoints — shares acquired after a deposit don't retroactively claim past months
- Treasury must be authorized as a game contract in MembersOnly (`setGameContract`)

---

## Craps System (Complete Architecture)

### Overview
Multiplayer craps (up to 4 players per table) using Cloudflare Workers + Durable Objects. Server-authoritative dice, HMAC anti-cheat, oracle-signed settlements.

### Entry Flow
1. Player selects chad on `gamble.html`, chooses chip wager amount
2. `Gamble.commitWager(tokenId, wager)` burns chips on-chain, returns nonce
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
- Idle kick (15 min inactivity → chips lost, logged to KV for 90 days)
- Turn timers: 20s bet timer (15s solo), 10s roll timer (multiplayer)
- 30s heartbeat ping/pong, 60s timeout = zombie disconnect

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
5. Chips credited. Nonce marked used (24h KV cache) to prevent replay.

**If player leaves without cashing out → chips are LOST.** `beforeunload` warning displayed.

---

## Tournament System

- Owner creates tournaments via `createTournament(name, startTime, endTime, chipCost, tokenGated, tournamentChips, rebuyAllowed)`
- Players enter via `enterTournament(tournamentId, tokenId)` — deducts chipCost, awards tournamentChips
- Players lock their score via `lockScore(tournamentId, tokenId, amount)`
- If rebuyAllowed, players can re-enter; new score replaces old only if higher
- Leaderboard paginated via `getLeaderboard(tournamentId, offset, limit)`

---

## Cloudflare Worker Backend (`worker/`)

| File | Purpose |
|------|---------|
| `runner-worker.js` | HTTP router: craps start/cashout, poker, hashcash, freeplay, pieface, table list |
| `craps-table.js` | Durable Object: game state, WebSocket, dice, payouts |
| `wrangler.toml` | Config: bindings, KV, contract addresses, RPC URL |

**Key endpoints:**
```
POST /craps/start         — verify wager, generate session token
POST /craps/cashout       — sign payout, mark nonce used
GET  /tables/list         — public table info
WS   /craps/ws            — connect to DO table instance
POST /poker/start|deal|draw|cashout — video poker endpoints
```

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
