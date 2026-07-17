# Members Only

> A fully on-chain, NFT-gated casino on Avalanche. Mint a membership pass, earn
> chips every week, play the tables, and climb the tournament leaderboard.

**Play:** [membersonly.cc](https://membersonly.cc)

---

## Table of Contents

1. [What is Members Only?](#what-is-members-only)
2. [The Membership NFT](#the-membership-nft)
3. [The Two Chip Currencies](#the-two-chip-currencies)
4. [Weekly Chip Drop](#weekly-chip-drop)
5. [The Games](#the-games)
6. [Tournaments](#tournaments)
7. [The Player-to-Player Market](#the-player-to-player-market)
8. [Smart Contracts](#smart-contracts)
9. [How the Contracts Fit Together](#how-the-contracts-fit-together-authorization--flow)
10. [Money & Solvency Model](#money--solvency-model)
11. [Off-Chain Backend (Cloudflare)](#off-chain-backend-cloudflare)
12. [Full Player Lifecycle](#full-player-lifecycle)
13. [Frontend](#frontend)
14. [Tech Stack](#tech-stack)
15. [Repository Layout](#repository-layout)
16. [Development](#development)
17. [Deployment](#deployment)
18. [Networks](#networks)
19. [Security Notes](#security-notes)
20. [License](#license)

---

## What is Members Only?

Members Only is a **pure casino** built on the Avalanche C-Chain. Access is gated
by an ERC-721 NFT membership pass. Everything a player owns — their pass, their
tier, their two kinds of chips, and any items — lives on-chain. The tables
(multiplayer craps, blackjack, roulette, video poker) run against a
server-authoritative backend on Cloudflare Workers + Durable Objects, and every
real-money payout is settled with an oracle signature the player redeems on-chain.

The economy has one guiding rule:

> **Anything free is a _tournament_ chip. Anything worth real AVAX is a _regular_ chip.**

There is no token that burns AVAX and no yield farming. Real money only flows in
two ways: buy/redeem regular chips 1:1 against the contract's AVAX reserve, and
win/lose them at the tables. Prizes are paid exclusively through tournaments.

---

## The Membership NFT

`MembersOnly.sol` — an ERC-721 pass ("a Chad").

| Property | Value |
|---|---|
| Max supply | **2222** |
| Mint price | **0.02 AVAX** |
| Max mint per wallet | **5** |
| Name | Set once via `setName` (12 char max, must be unique) |

### Rarity Tiers

Every pass has one of three tiers. The tier is **set by the owner after mint** to
match the token's metadata art, so an unset token defaults to **Common**. Tier
drives the size of the weekly tournament-chip drop.

| Tier | Target share | Weekly tournament chips |
|---|---|---|
| 1 · **Common** | 85% | **20** |
| 2 · **Rare** | 10% | **40** |
| 3 · **Legendary** | 5% | **100** |

Legendary passes are also visually distinguished in-game (a glow aura) and get the
rarest generated backdrops.

### Levels (mint-order based)

Level is a pure function of the token ID (the order it was minted) and adds a
`levelBonusChips[level]` bonus on top of the tier reward:

| Level | Token IDs |
|---|---|
| L1 | #1 – #555 |
| L2 | #556 – #1111 |
| L3 | #1112 – #1666 |
| L4 | #1667 – #2222 |

### Multi-pass identity

A wallet can hold up to 5 passes but plays as **one active pass at a time**. Your
casino name is that pass's on-chain `tokenName`. While a pass is marked
`isActive` (seated at a table), it **cannot be transferred** — this prevents
selling a pass mid-hand.

### Key owner/player functions

- `mint(quantity)` / whitelist mint variants (Merkle) — pay `MINT_PRICE * quantity`, receive passes + a rarity welcome drop of tournament chips.
- `setName(tokenId, name)` — name your pass.
- `claimWeeklyChips(tokenId)` / `claimWeeklyChipsBatch(tokenIds[])` — claim the weekly drop (mints **tournament** chips).
- `setActive(tokenId, bool)` — game/owner marks a pass as seated (locks transfer).
- `setTier(tokenId, tier)` / `setTierReward(tier, amount)` — owner sets rarity + reward.
- `setLevelBonus(level, amount)` — owner sets the per-level bonus.
- `setItems(address)` / `setGameContract(address, bool)` — wiring (see below).

---

## The Two Chip Currencies

Both chips are tokens in `MembersOnlyItems.sol` (an ERC-1155). Two token IDs are
reserved as currencies; all other IDs (starting at 2) are ordinary items.

### Regular chips — token ID `0` (real money)

- **Value:** pegged at **0.0001 AVAX** each, fully AVAX-backed.
- **Get them:** `buyChips()` (send AVAX, receive `msg.value / 0.0001 AVAX` chips; remainder refunded) — or win them at the main-floor tables.
- **Redeem:** `redeemChips(amount)` → `amount * 0.0001 AVAX` back to your wallet, always open.
- **Spend/award:** authorized game contracts call `burnChips` (losses/buy-ins) and `mintChips` (winnings).
- **Solvency invariant:** `contract balance >= chipSupply * 0.0001 AVAX` at all times. Minting winnings requires the house bankroll to be funded (`depositHouse()`), otherwise the mint reverts `"House underfunded"`.

### Tournament chips — token ID `1` (free, prize-only)

- **No cash value.** Cannot be redeemed for AVAX. Only usable to enter tournaments / redeem for prizes.
- **Get them:** the weekly rarity drop (20/40/100), the mint welcome bonus (= your tier's amount), item perks, or owner airdrops (`airdropTournamentChips`, `batchAirdropTournamentChips`).
- **Spend:** `Tournament.enterTournament` burns them via `burnTournamentChips`.

> Note: inside a tournament there is *also* an internal `tournamentChips` **score
> counter** (a plain `uint`, not a token). Keep the two concepts distinct.

---

## Weekly Chip Drop

Time is divided into fixed weeks (`weekLength = 7 days`, aligned to `weekAnchor`).
Each week a pass accrues `tierChipReward[tier] + levelBonusChips[level]` **tournament
chips**. Players sweep everything owed with `claimWeeklyChips(tokenId)` (per pass)
or `claimWeeklyChipsBatch([...])` (all owned passes in one transaction). Unclaimed
weeks accumulate until claimed.

---

## The Games

The main floor offers multiplayer **craps**, plus **blackjack**, **roulette**, and
**video poker**. All are played with **regular chips** you've bought or won.

- **Craps** is the flagship: up to 4 players per table, server-authoritative dice via `crypto.getRandomValues()`, HMAC anti-cheat, oracle-signed cash-outs. Full bet menu (pass/come/odds, field, place bets, hardways) with true-odds payouts.
- **Blackjack / poker** settle through the oracle (`Gamble.resolveGame`).

Entry/exit flow (regular-chip tables):

1. `Gamble.commitWager(tokenId, wager)` (or `cageBuyIn`) burns chips on-chain and returns a nonce.
2. The Worker verifies the on-chain commit and issues an HMAC session token; play happens against the Durable Object.
3. On cash-out the Worker signs `keccak256(tokenId, payout, nonce, player)` with the oracle key.
4. `Gamble.claimWinnings(tokenId, payout, nonce, signature)` credits chips on-chain. The nonce is marked used (replay-protected).

If a player leaves a table without cashing out, their in-play chips are **lost** —
the UI shows a `beforeunload` warning.

---

## Tournaments

`Tournament.sol` — the only place prizes (AVAX yield) are paid out.

**Lifecycle**

1. Owner `createTournament(name, startTime, endTime, chipCost, tournamentChips, rebuyAllowed)`.
2. Player `enterTournament(tournamentId, tokenId)` — burns `chipCost` **tournament chips**, receives an internal starting score.
3. Player `lockScore(tournamentId, tokenId)` — commits their current score. With `rebuyAllowed`, a new entry replaces the old **only if higher**.
4. Leaderboard is paginated via `getLeaderboard(tournamentId, offset, limit)`.

**Rank-based prize payout (owner-configurable)**

- `fundPrizePool(tournamentId)` *(payable)* — top the AVAX pool up with the week's yield.
- `setMinLockToQualify(tournamentId, minLock)` — minimum locked score to be eligible.
- `setPrizeWeights(tournamentId, weightsBps[])` — split by rank in basis points (`[10000]` = winner-take-all; `[6000,3000,1000]` = 60/30/10; sum ≤ 10000).
- `settleTournament(tournamentId, rankedTokenIds[])` — owner submits entrants ordered highest-locked-first; the contract verifies descending order + `minLock` and pays `pool * weight / 10000` to each qualifying token's owner. `settled` blocks double-pay, and funded pools are shielded from `withdraw()`.

---

## The Player-to-Player Market

`Market.sol` — a marketplace for trading membership passes / item NFTs between
players.

- `list(nftContract, tokenId, price)` / `delist(...)` — list or remove your listing.
- `buy(nftContract, tokenId)` *(payable)* — purchase at the listed price; a configurable protocol fee (`setFeeBps`, collected via `withdrawFees`) is taken.
- Only approved NFT contracts can be listed (`setApprovedContract(s)`); the owner can `adminDelist` if needed.

---

## Smart Contracts

Six contracts in [`/contracts`](contracts):

| Contract | Purpose |
|---|---|
| **`MembersOnly.sol`** | ERC-721 membership pass — 2222 max, 0.02 AVAX mint, 3 rarity tiers, 4 levels, weekly tournament-chip drop, naming, Merkle whitelist, transfer-lock while active. |
| **`MembersOnlyItems.sol`** | ERC-1155 — regular chips (id 0, 0.0001 AVAX-backed) + tournament chips (id 1, free) + arbitrary items. Holds the AVAX reserve + house bankroll. |
| **`Gamble.sol`** | Regular-chip wagering: `commitWager`/`claimWinnings` (craps) and `resolveGame` (oracle-settled blackjack/poker); cage buy-in; wager limits + max-payout guard. |
| **`Tournament.sol`** | Tournament system: entry (burns tournament chips), score locking, rebuy, leaderboard, rank-weighted AVAX prize pools. |
| **`Market.sol`** | Player-to-player NFT/item trading with a protocol fee. |
| **`TraditionalGambling.sol`** | Standalone ETH-backed chip house with **no NFT gate** (1 chip = 0.005 ETH). Independent of the membership economy; pausable. |

---

## How the Contracts Fit Together (Authorization & Flow)

```
                 ┌──────────────────┐
   mint 0.02 AVAX│   MembersOnly    │  ERC-721 pass, tiers, levels, weekly claim
 ───────────────▶│    (ERC-721)     │───────────┐ mints TOURNAMENT chips on claim
                 └────────┬─────────┘           │
                          │ setItems()          ▼
                          │            ┌───────────────────────┐
                          │            │  MembersOnlyItems      │
     buyChips 0.0001 AVAX│            │   (ERC-1155)           │
 ─────────────────────────┼───────────▶│  id 0: regular chips   │
                          │            │  id 1: tournament chips│
                          │            │  id 2+: items          │
                          │            └───────┬───────┬────────┘
                          │        mint/burn   │       │ burn tournament chips
                          │        regular     │       │
              ┌───────────▼──────┐   ┌─────────▼──┐  ┌─▼──────────────┐
              │     Gamble       │   │  (winnings)│  │  Tournament    │
              │  commitWager /   │   └────────────┘  │  enter/lock/   │
              │  claimWinnings   │                   │  settle (AVAX) │
              └──────────────────┘                   └────────────────┘

     Market (ERC-721/1155 trading)  — orthogonal, trades passes & items
```

**Wiring the owner must perform once after deploy:**

1. `MembersOnly.setItems(itemsAddress)` — so the pass can mint tournament chips.
2. `MembersOnlyItems.setGameContract(addr, true)` for **MembersOnly**, **Gamble**, and **Tournament** — authorizes each to mint/burn chips.
3. `Gamble.setOracle(...)` (and `TraditionalGambling.setOracle(...)`) — the key that signs payouts.
4. Fund the house: `MembersOnlyItems.depositHouse()` so winnings can be minted.

---

## Money & Solvency Model

- **Regular chips are 1:1 AVAX-backed.** The Items contract must always hold at least `chipSupply * 0.0001 AVAX` (`reserveRequired()`).
- **House bankroll** = anything above the reserve (`houseSurplus()`). Winnings are minted from it; owner `withdraw()` can only take the surplus, never the reserve.
- **Buying** chips is self-backing (player deposits exactly the peg). **Losing/spending** chips frees reserve into the surplus. **Redeeming** pays out at the peg.
- **Nothing burns AVAX.** "Burn" only ever means destroying chip *tokens* (losses, tournament entry). Yield reaches players only through tournament prize pools.

---

## Off-Chain Backend (Cloudflare)

The table logic lives in [`/worker`](worker) on Cloudflare Workers + Durable Objects (DO).

| File | Role |
|---|---|
| `runner-worker.js` | HTTP router: craps start/cashout, poker, hashcash, table list. |
| `craps-table.js` | **Durable Object** — the single source of truth for one craps table: game phase, per-player stacks/bets, shooter rotation, server-side dice, payout resolution, idle-kick, turn/heartbeat timers. |
| `clubnile-room.js`, `hashcash-table.js` | Additional room/DO logic. |
| `wrangler.toml` | Bindings, KV, contract addresses, RPC URL. |

Key endpoints:

```
POST /craps/start          verify the on-chain wager, issue an HMAC session token
POST /craps/cashout        sign the payout, mark the nonce used (24h KV replay cache)
GET  /tables/list          public table info
WS   /craps/ws             connect to a table's Durable Object
POST /poker/start|deal|draw|cashout
```

The DO owns all state: dice are rolled server-side (never on the client), bets are
validated and resolved on every roll, and disconnects/idle-outs are handled
authoritatively (chips lost on abandon, logged to KV).

---

## Full Player Lifecycle

```
1. MINT          MembersOnly.mint()              → pass + rarity welcome (tournament chips)
2. SETUP         MembersOnly.setName()           → name your pass (12 chars)
3. WEEKLY CLAIM  MembersOnly.claimWeeklyChips()  → 20 / 40 / 100 tournament chips
4. BUY CHIPS     Items.buyChips() (0.0001 AVAX ea) → regular chips to gamble with
5. GAMBLE        Gamble.commitWager()            → buy-in regular chips
6. PLAY          WebSocket → Durable Object       → multiplayer craps / tables
7. CASH OUT      Gamble.claimWinnings()          → oracle-signed payout
8. REDEEM        Items.redeemChips()             → regular chips → 0.0001 AVAX each
9. TOURNAMENT    Tournament.enter / lockScore    → owner settleTournament pays the pool
```

---

## Frontend

The site is a static app hosted on GitHub Pages ([`index.html`](index.html) and the
themed casino builds in [`/games`](games)). The playable casino is a single-file
HTML5 canvas game with procedurally generated pixel-art characters, a walkable
casino floor, and wallet integration (ethers.js v5 + AppKit/Reown, WalletConnect
v2). The repo ships several cosmetic **re-skins over the same contracts** (e.g.
Club Nile, and themed variants such as Rob's Hideout / Tuck's Treasure Trove /
Giraffe Sanctuary) — art and flavor differ, the economy does not.

Every HTML page ships a strict Content-Security-Policy meta tag that whitelists
only the RPC/WalletConnect/CDN origins the app needs, so injected scripts can't
craft malicious transactions.

---

## Tech Stack

- **Solidity** 0.8.26 + **OpenZeppelin** 5.0.0 (ERC721, ERC1155, Ownable, ReentrancyGuard, Pausable)
- **Hardhat** 2.28.5
- **ethers.js** v5 + AppKit / Reown (WalletConnect v2)
- **Cloudflare Workers + Durable Objects** for table state
- **GitHub Pages** hosting; **GitHub Actions** for deploys

---

## Repository Layout

```
contracts/        6 Solidity contracts (+ mocks/)
worker/           Cloudflare Worker + Durable Objects
games/            themed HTML5 casino frontends
metadata/         immutable NFT metadata (do not modify)
assets/, chads/   NFT artwork & assets (do not modify)
docs/             GIRAFFE_CASINO_BLUEPRINT.md — full rebuild spec
test/             Hardhat test suite
index.html        landing page
docs.html         in-app documentation
```

📘 The end-to-end blueprint — every contract, the worker/DO layer, the oracle
settlement scheme, and the deploy runbook — lives in
[`docs/GIRAFFE_CASINO_BLUEPRINT.md`](docs/GIRAFFE_CASINO_BLUEPRINT.md).

---

## Development

```bash
npm install
npm test                              # full test suite
npx hardhat compile                   # compile contracts
npx hardhat test --grep "keyword"     # run a subset
```

---

## Deployment

Contracts are deployed and managed through **GitHub Actions**, not local commands.
Deployment (testnet or mainnet) is **never** run automatically — a deploy always
requires explicit human confirmation before the workflow is executed.

---

## Networks

| Network | Purpose |
|---|---|
| Avalanche Mainnet | Production |
| Fuji Testnet | Testing & deployment staging |

---

## Security Notes

- **Server-authoritative games:** dice and outcomes are generated server-side; clients never roll their own.
- **Oracle-signed payouts** with per-nonce replay protection (KV cache).
- **Transfer lock** on active passes prevents selling mid-hand.
- **Solvency invariant** keeps regular chips fully AVAX-backed; the owner can only withdraw genuine house surplus.
- **Strict CSP** on every page blocks third-party script injection.

---

## License

MIT
