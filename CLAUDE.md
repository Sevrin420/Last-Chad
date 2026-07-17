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

### Asset Path Convention
All project assets (images, GIFs, audio, etc.) live in **`assets/membersonly/`** unless the user specifies otherwise. Always reference new assets from that path. Never guess a different location.

### Off-Limits Files
- **`assets/`** — Do NOT touch NFT images or asset folders.
- **`metadata/`** — NEVER modify. NFT metadata is set and immutable.
- **`chads/`** — NFT artwork, do not modify.
- **`hashcash/`** — Do NOT modify any hashcash files unless explicitly asked.
- **`freeplay/`** — Do NOT modify any freeplay/pieface files unless explicitly asked.

---

## Project Overview

**Members Only** is an NFT-gated casino on Avalanche. 2222 Club Nile NFTs grant access to multiplayer craps, poker, tournaments, and a player-to-player market. Hosted on GitHub Pages at membersonly.cc.

### Elevator Pitch

Members Only is a **pure casino**. Mint a Chad, earn chips weekly (based on your Tier and Level), and spend them at the tables. Top chip holders dominate the leaderboard. Tournaments let players compete for prizes by locking their chip stacks as scores.

**Tech Stack:** Hardhat v2.28.5, Solidity v0.8.26, OpenZeppelin v5.0.0, ethers.js v5 + AppKit/Reown, Cloudflare Workers + Durable Objects.

> 📘 **Full rebuild spec:** [`docs/GIRAFFE_CASINO_BLUEPRINT.md`](docs/GIRAFFE_CASINO_BLUEPRINT.md)
> — an end-to-end blueprint of every contract, the off-chain worker/DO layer,
> the oracle settlement scheme, and the deploy runbook. Detailed enough to
> rebuild the whole casino from scratch. Keep it in sync when contracts change.

---

## Smart Contracts (6 total, in `/contracts`)

| Contract | Purpose |
|----------|---------|
| `MembersOnly.sol` | ERC-721 NFT (2222 max, 0.02 AVAX mint, 3 rarity tiers, levels, weekly tournament-chip drop, partner bonus, Merkle whitelist) |
| `MembersOnlyItems.sol` | ERC-1155: regular chips (token 0, 0.0001 AVAX-backed) + tournament chips (token 1, free) + items |
| `Gamble.sol` | Regular-chip wagering: commitWager/claimWinnings (craps), resolveGame (oracle, blackjack/poker) |
| `Market.sol` | Player-to-player NFT/item trading |
| `Tournament.sol` | Tournament system: enter (burns tournament chips), lock score, rebuy, leaderboard |
| `TraditionalGambling.sol` | Standalone ETH-backed chip house (no NFT gate), 1 chip = 0.005 ETH |

**Authorization chain:** Owner must call `setGameContract(address, true)` on **MembersOnlyItems** to authorize MembersOnly, Gamble, and Tournament (for chip mint/burn). MembersOnly also needs `setItems(itemsAddress)` to know about Items.

**Key constants:**
- `MAX_SUPPLY`: 2222
- `MINT_PRICE`: 0.02 AVAX
- `MAX_MINT_PER_WALLET`: 5
- `CHIP_PRICE`: 0.0001 AVAX per regular chip (buy & redeem, AVAX-backed)
- Level by mint order: #1-555=L1, #556-1111=L2, #1112-1666=L3, #1667-2222=L4
- **Rarity tiers** (owner-set to match metadata, target split across 2222):
  - Tier 1 **Common** — 85% — **20** tournament chips/week
  - Tier 2 **Rare** — 10% — **40** tournament chips/week
  - Tier 3 **Legendary** — 5% — **100** tournament chips/week

---

## Player Lifecycle

```
1. MINT         mint.html   → MembersOnly.mint() (0.02 AVAX)    → ERC-721 + rarity welcome (tourney chips)
2. SETUP        mint.html   → MembersOnly.setName()           → name (12 char max)
3. WEEKLY CLAIM mint.html   → MembersOnly.claimWeeklyChips()  → 20/40/100 tournament chips
4. BUY CHIPS    mint.html   → Items.buyChips() (0.0001 AVAX)    → regular chips to gamble with
5. GAMBLE       gamble.html → Gamble.commitWager()            → buy-in regular chips
6. CRAPS        craps.html  → WebSocket to Durable Object     → multiplayer craps
7. CASHOUT      craps.html  → Gamble.claimWinnings()          → oracle-signed payout
8. REDEEM       mint.html   → Items.redeemChips()             → regular chips → 0.0001 AVAX each
9. TOURNAMENT   tournament.html → enter/lockScore; owner settleTournament → top locks win the yield
```

---

## Chip System (two currencies)

**Rule of thumb: anything free is a tournament chip; anything worth real AVAX is a regular chip.**

**Regular chips** = ERC-1155 token **ID 0** — real money, **0.0001 AVAX each**, AVAX-backed
- Get them: `items.buyChips()` (0.0001 AVAX each) or win at the main-floor tables
- Redeem: `items.redeemChips(amount)` → 0.0001 AVAX each, always open
- Spend/award: Gamble calls `items.burnChips` / `items.mintChips` (winnings)
- **Solvency invariant**: `balance >= chipSupply * 0.0001 AVAX`. Free mints (winnings) require the house bankroll to be funded via `items.depositHouse()` or they revert `"House underfunded"`. Owner `withdraw()` can only take the surplus above the reserve.

**Tournament chips** = ERC-1155 token **ID 1** — free, **no cash value**, prize-only
- Get them: weekly rarity drop (20/40/100) + mint welcome bonus (= the token's rarity amount) + item perks
- **Mint welcome bonus** = `tierChipReward[effectiveTier(id)]`. Rarity is set post-mint, so unset tier defaults to **Common (20)**; owner upgrades chosen tokens to Rare/Legendary afterward. **No partner-NFT chip bonus** (removed).
- Award directly: owner `items.airdropTournamentChips(to, amount)` / `batchAirdropTournamentChips(...)`
- Award via items: `WeeklyChipBonus` item = +X tournament chips/week (an item that *increases chips received*); `OneTimeChipClaim` item = one-time grant
- Claim weekly: `claimWeeklyChips(tokenId)` per pass, or `claimWeeklyChipsBatch(tokenIds[])` to sweep every owned pass in one tx (the game's "MY GIRAFFES" popup)
- Multi-NFT identity: a wallet plays as one **active** pass at a time; your casino name is that pass's `tokenName`. Switch active in the MY GIRAFFES popup.
- Spend: `Tournament.enterTournament` burns them via `items.burnTournamentChips`
- Cannot be redeemed for AVAX; only usable to enter tournaments / redeem for prizes
- Inside a tournament there's ALSO an internal `entry.tournamentChips` score counter (a `uint`, not a token) — keep distinct

**Authorization**: every contract that mints/burns either chip (MembersOnly, Gamble, Tournament) must be authorized in MembersOnlyItems via `setGameContract`.

---

## Yield / Prizes

Yield is paid **only** through tournaments (rank-based prize pools — see the
Tournament System section). The old chip-burn treasury/share vault was
**removed**. **Nothing burns AVAX** anywhere in the system, and no real-money
chips are destroyed for yield — "burn" only ever means destroying chip *tokens*
(losses, tournament entry).

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

- Owner creates tournaments via `createTournament(name, startTime, endTime, chipCost, tournamentChips, rebuyAllowed)`
- Players enter via `enterTournament(tournamentId, tokenId)` — burns `chipCost` **tournament chips** (token 1), awards internal `tournamentChips` score counter
- Players lock their score via `lockScore(tournamentId, tokenId)`
- If rebuyAllowed, players can re-enter; new score replaces old only if higher
- Leaderboard paginated via `getLeaderboard(tournamentId, offset, limit)`

**Rank-based yield/prize payout (owner-configurable):**
- `fundPrizePool(tournamentId)` (payable) — top up the AVAX pool with the week's yield
- `setMinLockToQualify(tournamentId, minLock)` — min chips a player must lock to win
- `setPrizeWeights(tournamentId, weightsBps[])` — split by rank in bps (`[10000]` = winner-take-all; `[6000,3000,1000]` = 60/30/10); sum ≤ 10000
- `settleTournament(tournamentId, rankedTokenIds[])` — owner passes entrants ordered highest-locked-first; contract verifies descending order + minLock, pays `pool * weight / 10000` to each qualifying token's owner. `settled` blocks double-pay; funded pools are shielded from `withdraw()`.

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
