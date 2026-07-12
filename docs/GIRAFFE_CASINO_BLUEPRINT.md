# Giraffe Casino — Full Rebuild Blueprint

> **Purpose of this document.** This is a from-scratch specification of the
> entire Giraffe Casino / Members Only stack: the five (six, counting the
> traditional-money house) smart contracts, how they authorize and call each
> other, the off-chain Cloudflare Worker + Durable Object layer, the oracle
> settlement scheme, the browser games, and the exact deploy/authorize runbook.
> A competent Solidity + web dev should be able to recreate the whole system
> from this file alone.
>
> **Canonical source of truth is still the code** in `/contracts`, `/worker`,
> and `/games`. When this doc and the code disagree, the code wins — then fix
> this doc.

---

## 0. TL;DR — what it is

**Giraffe Casino** (the giraffe-themed re-skin of "Members Only" / "Rob's
Hideout") is an **NFT-gated, on-chain casino on Avalanche**, served as static
HTML on GitHub Pages, with real-time multiplayer tables driven by Cloudflare
Workers + Durable Objects.

Three layers:

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — ON-CHAIN (Avalanche C-Chain / Fuji testnet)               │
│  Solidity 0.8.26 · OpenZeppelin v5 · Hardhat                          │
│                                                                        │
│  MembersOnly (ERC-721)  ── mints ──►  MembersOnlyItems (ERC-1155)     │
│      NFT + rarity tiers + weekly chip drop   regular chips (id 0) +   │
│                                              tournament chips (id 1)  │
│                                              + items                  │
│        ▲            ▲              ▲                                   │
│        │ ownerOf    │ burn/mint    │ burn (tourney chips)              │
│   Gamble        Market         Tournament                             │
│   (wager        (trade         (compete; rank-based AVAX prize pool,  │
│    regular       NFTs/items)    top locked scores win the yield)      │
│    chips)                                                             │
│                                                                        │
│  TraditionalGambling — standalone ETH-backed chip house (no NFT gate) │
└──────────────────────────────────────────────────────────────────────┘
                              ▲   │
                oracle-signed │   │ read ownerOf / isActive, verify wager
                  settlements │   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 2 — OFF-CHAIN AUTHORITY (Cloudflare)                           │
│  runner-worker.js (HTTP router) · Durable Objects (game state)       │
│  ORACLE_PRIVATE_KEY signs every payout · KV for nonce/idle logs       │
│                                                                        │
│  ClubNileRoom DO — SHARED tables: server owns the RNG + clock for     │
│  craps / roulette / blackjack; clients own their own chips & bets.    │
│  CrapsTable DO (legacy) · HashCashTable DO                            │
└──────────────────────────────────────────────────────────────────────┘
                              ▲   │
                    WebSocket │   │ HTTPS (mint, claim, wager, cashout)
                              ▼   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 3 — FRONT-END (GitHub Pages, static)                          │
│  games/giraffesanctuary.html — single-file canvas game (~6k lines)   │
│  ethers.js v5 + Reown/AppKit wallet · procedural pixel-art giraffes   │
│  mint.html / tournament.html / market pages                          │
└──────────────────────────────────────────────────────────────────────┘
```

**Two currencies, both ERC-1155 tokens in `MembersOnlyItems`:**

| | **Regular chips** (token 0) | **Tournament chips** (token 1) |
|---|---|---|
| Value | **0.05 AVAX each** — real money | **none** — cannot be cashed out |
| How you get them | **buy** at 0.05 AVAX, or win at the tables | free: **weekly rarity drop** + mint welcome bonus + item perks |
| What they're for | wagering at the main-floor tables (real money) | entering tournaments / redeeming for prizes |
| Backing | fully **AVAX-backed** (solvency invariant, see §3) | unbacked (free faucet currency) |
| Redeem | `redeemChips()` → 0.05 AVAX each, always | never — prize-only |

Both are per-wallet and transferable. The rule of thumb: **anything free is
tournament chips; anything worth real AVAX is a regular chip.** Inside a live
tournament there is *also* an internal score counter called
`entry.tournamentChips` (see §5) — distinct from the token-1 balance.

**Mint price: 10 AVAX** per NFT.

---

## 1. Rarity tiers & the weekly chip drop  ⭐ (the economic core)

Every NFT has a **rarity tier**, set by the owner to match the token's
immutable metadata trait. There are **three tiers**, with a target mint
distribution and a fixed **weekly tournament-chip allowance**:

| Tier | Name        | uint8 | Share  | Count @ 333 supply | Tournament chips / week |
|------|-------------|:-----:|:------:|:------------------:|:-----------------------:|
| 1    | **Common**  | `1`   | 90 %   | ~300               | **50**       |
| 2    | **Rare**    | `2`   |  9 %   | ~30                | **80**       |
| 3    | **Legendary** | `3` |  1 %   | ~3                 | **200**      |

- The weekly drop is minted as **tournament chips (ERC-1155 token 1)** — the
  free, prize-only currency. Players claim it once per week per token via
  `MembersOnly.claimWeeklyChips(tokenId)`, which calls
  `items.mintTournamentChips`.
- Unclaimed weeks **stack**: a claim mints `reward × (currentWeek − lastClaimWeek)`.
- The reward formula is `tierChipReward[tier] + levelBonusChips[level]`. The
  **level bonus defaults to 0**, so out of the box a token earns exactly its
  tier amount (50 / 80 / 200). Level bonus is an optional owner-tunable
  add-on (levels are mint-order based, see §2.1) and is not part of the core
  rarity economy.

### 1.1 Where tiers live in the contract (`MembersOnly.sol`)

```solidity
uint8 public constant TIER_COMMON    = 1;
uint8 public constant TIER_RARE      = 2;
uint8 public constant TIER_LEGENDARY = 3;

mapping(uint256 => uint8)  public tokenTier;      // tokenId => tier
mapping(uint8   => uint256) public tierChipReward; // tier   => tournament chips/week

// constructor sets defaults:
tierChipReward[TIER_COMMON]    = 50;
tierChipReward[TIER_RARE]      = 80;
tierChipReward[TIER_LEGENDARY] = 200;
```

> The reward is paid in **tournament chips** (token 1), not real-money chips.
> `claimWeeklyChips` mints `reward × claimableWeeks` via `mintTournamentChips`.

Owner assigns tiers to match metadata (single or batch), targeting the
90 / 9 / 1 split across the 333 tokens:

```solidity
setTier(uint256 tokenId, uint8 tier)                      // tier ∈ [1,3]
batchSetTier(uint256[] tokenIds, uint8[] tiers)           // bulk
setTierReward(uint8 tier, uint256 amount)                 // retune a tier's drop
tierName(uint256 tokenId) → "Common" | "Rare" | "Legendary" | ""
```

> **Rebuild note.** Tier assignment is **owner-set, not on-chain random**.
> This deliberately mirrors the immutable metadata: you decide which token IDs
> are Common/Rare/Legendary (to match the artwork), then call `batchSetTier`.
> If you instead want provably-random rarity at mint, you'd add a VRF and set
> `tokenTier` in `_mintInternal` — that is a design change, not the current
> behavior.

---

## 2. Contract 1 — `MembersOnly.sol` (ERC-721 membership NFT)

**Inherits:** `ERC721Enumerable`, `Ownable`. **The gate for everything.**

**Constants**

| Name | Value | Meaning |
|------|-------|---------|
| `MAX_SUPPLY` | 333 | hard cap |
| `MINT_PRICE` | **10 ether** | 10 AVAX per mint |
| `MAX_MINT_PER_WALLET` | 5 | anti-whale |
| `TIER_COMMON/RARE/LEGENDARY` | 1/2/3 | rarity |

> **Welcome bonus = the token's rarity weekly amount** (50 / 80 / 200), paid
> once at mint in **tournament chips** via `items.mintTournamentChips`. Because
> rarity is assigned *after* mint (to match metadata), the grant uses
> `effectiveTier` — an unset tier defaults to **Common (50)**, so a fresh mint
> gets 50 and the owner upgrades chosen tokens to Rare/Legendary afterward
> (which then earn 80 / 200 on every weekly claim). **No partner-NFT chip bonus**
> — that has been removed. No free real-money chips are ever minted (that would
> break the regular-chip AVAX peg, §3).

### 2.1 Levels (mint-order, pure function — distinct from tiers)

`getLevel(tokenId)` is a **pure** function of mint order (nothing to do with
rarity):

```
#1–83   → L1     #84–166 → L2     #167–249 → L3     #250–333 → L4
```

Level feeds only the optional `levelBonusChips[level]` add-on (default 0).

### 2.2 Minting paths

All three burn `MINT_PRICE × quantity` AVAX (10 AVAX each), enforce supply +
per-wallet caps, mint the ERC-721, set `lastClaimWeek[tokenId] = currentWeek()`
(so the weekly drop starts accruing next week, no backfill), and mint the
per-token welcome bonus `Σ tierChipReward[effectiveTier(tokenId)]` in
**tournament chips** via `items.mintTournamentChips`:

- `mint(quantity)` — public.
- `mintWithInvitation(quantity)` — also burns 1 invitation item (`invitationItemId`).
- `mintWhitelist(quantity, proof)` — Merkle-proof gated (`merkleRoot`).

### 2.3 Weekly chip claiming (time-based, auto-rolling)

```solidity
weekLength = 7 days;            // owner-tunable 1h–30d
weekAnchor = <deploy time>;     // owner can align to e.g. Monday 00:00 UTC
currentWeek()      = (block.timestamp - weekAnchor) / weekLength;
claimableWeeks(id) = currentWeek() - lastClaimWeek[id]  (>=0);
claimWeeklyChips(id): reward = tierChipReward[effectiveTier(id)] + levelBonusChips[level];
                      mints reward × claimableWeeks (tournament chips); sets lastClaimWeek.
effectiveTier(id): tokenTier[id] == 0 ? Common : tokenTier[id]   // unset → Common
```

Views for the UI: `nextDropAt()`, `getWeeklyReward(id)`, `claimableChips(id)`,
`hasClaimed(id, week)`.

### 2.4 Other mechanics

- **Naming:** `setName(id, name)` — unique (case-insensitive), ≤12 chars, once.
- **Active lock:** `isActive[id]` blocks transfers while a token is "seated" in
  a game. Set by authorized games or owner via `setActive`. `_update` reverts
  transfers of active tokens. This is what stops a player selling an NFT
  mid-hand.
- **Partners:** owner can register partner ERC-721 contracts and query
  `hasPartnerNFT(wallet)`. The registry is retained for future perks, but it
  **no longer grants any chip bonus at mint** (that was removed).
- **Game authorization:** `setGameContract(addr,bool)` → `authorizedGame`.
  Gates `onlyGameOrOwner` (used by `setActive`).
- **Items link:** `setItems(addr)` tells the NFT where chips live;
  `setInvitationItemId(id)`.

**Key external calls out:** `items.mintChips`, `items.burnItem`,
`items.balanceOf`.

---

## 3. Contract 2 — `MembersOnlyItems.sol` (ERC-1155 chips + items)

**Inherits:** `ERC1155`, `Ownable`. **Holds the money.** Two jobs in one
contract: (a) the two chip currencies, (b) arbitrary item types.

### 3.1 The two currency tokens (reserved IDs 0 & 1)

```solidity
uint256 public constant CHIPS_ID   = 0;          // regular chips — real money
uint256 public constant TCHIPS_ID  = 1;          // tournament chips — prize-only
uint256 public constant CHIP_PRICE = 0.05 ether; // 1 regular chip == 0.05 AVAX
uint256 public chipSupply;                        // regular chips in circulation
uint256 public nextItemId = 2;                    // items start at 2; 0 & 1 reserved
```

**Regular chips (token 0) — AVAX-backed, 0.05 AVAX each.**

```solidity
buyChips()                external payable   // 0.05 AVAX → chips (refunds remainder)
redeemChips(amount)       external           // chips → 0.05 AVAX each, always open
mintChips(to, amount)     onlyAuthorized     // free mint (winnings); asserts backing
burnChips(from, amount)   onlyAuthorized     // spends/losses; frees reserve
depositHouse()            payable onlyOwner  // fund the bankroll for net payouts
reserveRequired() → chipSupply * CHIP_PRICE  // AVAX that must stay locked
houseSurplus()    → balance - reserveRequired()
withdraw()        onlyOwner                  // owner may take houseSurplus() only
```

> **Solvency invariant:** `address(this).balance >= chipSupply * CHIP_PRICE`
> after every state change. `buyChips` self-backs (adds exactly its own AVAX).
> `mintChips` (game winnings) is a *free* mint, so it asserts the invariant —
> the owner must have funded the house bankroll via `depositHouse` or it
> reverts `"House underfunded"`. `withdraw` can only take the surplus above the
> reserve, so the ETH backing player chips can never be pulled out.
>
> **`chipSupply` is maintained everywhere token-0 is minted/burned:** buy,
> redeem, mint (winnings), and burn (losses/spends). Only these paths touch
> token 0.

**Tournament chips (token 1) — free, no cash value.**

```solidity
mintTournamentChips(to, amount)      onlyAuthorized  // weekly drop, welcome bonus
burnTournamentChips(from, amount)    onlyAuthorized  // tournament entry cost
getTournamentChips(wallet) → balanceOf(wallet,1)
airdropTournamentChips(to, amount)   onlyOwner       // award chips directly
batchAirdropTournamentChips(to[], amount[]) onlyOwner
```

No AVAX reserve, no `redeem` path — they can only be spent entering
tournaments / redeemed for prizes off-chain.

**Two ways to award tournament chips (per the design brief):**
1. **Directly** — owner `airdropTournamentChips` / `batchAirdropTournamentChips`.
2. **Via items** — create an item and award it:
   - `ItemType.WeeklyChipBonus` (bonusAmount = X): once utilized on an NFT,
     `claimWeeklyItemBonus` grants X extra **tournament chips per week** — i.e.
     an item that *increases the tournament chips received*.
   - `ItemType.OneTimeChipClaim` (bonusAmount = X): `claimOneTimeBonus` grants X
     tournament chips once. Both mint token 1.

`onlyAuthorized` = `authorizedGame[msg.sender] || owner`. Every contract that
moves either chip (MembersOnly, Gamble, Tournament) must be authorized here via
`setGameContract(addr,true)`. **This is the single most important wiring step.**

> **Accounting note:** the contract's AVAX balance backs the chip reserve plus
> the house bankroll (`depositHouse`) plus any item-sale proceeds. The invariant
> guards chip minting; `withdraw` only ever releases `houseSurplus()`, so player
> chip backing is always protected. (There is no treasury/yield vault sharing
> this balance any more — see §3.3.)

### 3.2 Items (`ItemType`: `WeeklyChipBonus`, `OneTimeChipClaim`, `AreaAccess`)

- `createItem(name,maxSupply,price,stackable,itemType,bonusAmount)` → itemId.
- Sold via `mint(itemId,qty)` (payable), airdropped, or allow-list claimed
  (`setItemClaimable` + `claimItem`).
- **Utilize/unutilize:** lock an item to a specific NFT (`utilizeItem`) to
  activate its perk; unutilize to trade it.
- Perk claims: `claimWeeklyItemBonus(tokenId, itemIds[])` (once per item per
  NFT per `currentWeek`), `claimOneTimeBonus(tokenId, itemId)`. Both pay
  **tournament chips**.

> **No treasury/yield vault.** An earlier design had players burn 10k chips per
> share for a monthly AVAX yield; it was **removed**. Yield is now paid purely
> through the rank-based tournament prize pool (§5) — the top locked scores win
> the week's AVAX. **Nothing burns AVAX anywhere in the system**, and no
> real-money chips are destroyed for yield.

---

## 4. Contract 3 — `Gamble.sol` (chip wagering for NFT holders)

**Not** Ownable — uses an immutable `gameOwner` (deployer) and a mutable
`oracle`. Holds references to `membersOnly` and `items` (both immutable).
Must be authorized in `MembersOnlyItems`.

**Guardrails:** `minWager=1`, `maxWager=500`, `maxPayoutMultiplier=20`,
`cageLimit=1_000_000` (all owner-tunable). Replay protection via
`usedNonces`.

Gamble settles the main-floor tables, so it moves **regular chips** (token 0,
real money) via `items.burnChips` / `items.mintChips`. Because winnings are a
free mint, the Items house bankroll must be funded (§3.1) or payouts revert.

**Three settlement paths — all end in `items.burnChips` / `items.mintChips`:**

1. **`resolveGame(tokenId, wager, payout, gameId, nonce, sig)`** — single-tx.
   Worker signs `keccak256(tokenId, wager, payout, gameId, nonce, player)`.
   Burns wager, mints payout (0 = loss). For blackjack/poker etc.
2. **`commitWager(tokenId, wager)` → `claimWinnings(tokenId, payout, nonce, sig)`**
   — two-tx. TX1 burns chips up front and returns a nonce; TX2 (win only)
   mints payout after the Worker signs `keccak256(tokenId, payout, nonce, player)`.
   For live craps/poker.
3. **The Cage: `cageBuyIn(tokenId, amount)` → `cageCashOut(tokenId, amount, nonce, sig)`**
   — buy a stack into an off-chain session (chips burned now); cash out the
   remainder (Worker signs `keccak256(tokenId, amount, nonce, player)`). Any
   chips not cashed out stay burned = the house edge / losses.

Every path checks `membersOnly.ownerOf(tokenId) == msg.sender` and (except
cash-outs) `!membersOnly.isActive(tokenId)`.

---

## 5. Contract 4 — `Tournament.sol` (compete for prizes)

**Inherits:** `Ownable`, `ReentrancyGuard`. Authorized in `MembersOnlyItems`
(to burn the entry cost). Accepts AVAX (`receive()`) for prize pools.

**Model:**
- Owner: `createTournament(name, start, end, chipCost, tournamentChips, rebuyAllowed)`.
- Player: `enterTournament(id, tokenId)` — burns `chipCost` **tournament chips
  (ERC-1155 token 1)** via `items.burnTournamentChips`, and credits
  `tournamentChips` as an **internal score counter** on the entry (a plain
  `uint`, NOT a token — this is the number the UI shows *inside* a tournament).
- During play the owner/oracle adjusts the internal counter via
  `awardTournamentChips` / `spendTournamentChips` (hitting 0 = `busted`).
- `lockScore(id, tokenId)` — commits the current internal counter as the
  player's leaderboard `score`. Rebuy (if allowed) lets a busted player
  re-enter; a new locked score only replaces the old if higher.
- Leaderboard: `getLeaderboard(id, offset, limit)` (paginated).

**Rank-based yield / prize settlement (owner-configurable).** The player who
locks the most chips takes the week's yield; the exact rules are tunable:

```solidity
fundPrizePool(id)                  payable   // top up the AVAX pool (e.g. the week's yield)
setMinLockToQualify(id, minLock)   onlyOwner // min locked chips to be eligible for a prize
setPrizeWeights(id, weightsBps[])  onlyOwner // payout split by rank, bps; sum ≤ 10000
                                             //   [10000]            = winner-take-all
                                             //   [6000,3000,1000]   = 1st/2nd/3rd = 60/30/10
settleTournament(id, rankedTokenIds[]) onlyOwner nonReentrant
```

`settleTournament` takes the entrants ordered by locked score (highest first —
the owner/oracle reads the leaderboard off-chain and passes the order). The
contract **verifies the order is non-increasing**, skips any rank whose locked
score is below `minLockToQualify`, and pays `pool × weightsBps[rank] / 10000`
to each qualifying token's current owner. `settled[id]` blocks double payout;
`totalPooled` shields funded pools from `withdraw()`. Winner-take-all
(`[10000]`) is literally "lock the most → get the yield." The manual
`distributePrize(winners[], amounts[])` path is still available.

> **Two meanings of "tournament chips":** (1) the ERC-1155 **token 1** a player
> spends as `chipCost` to enter (the free weekly-drop currency); (2) the
> internal `entry.tournamentChips` **score counter** (a `uint`) that lives only
> inside the tournament and is what the leaderboard locks. Keep them distinct
> when rebuilding.

---

## 6. Contract 5 — `Market.sol` (P2P trading)

**Inherits:** `Ownable`, `ReentrancyGuard`. Trades any **approved** ERC-721 or
ERC-1155 contract for AVAX. Not chip-aware.

- `feeBps = 500` (5 %, ≤10 % cap) → `accumulatedFees`, owner withdraws.
- ERC-721: `list / delist / buy`. ERC-1155: `list1155 / delist1155 / buy1155`.
- **O(1) enumeration** via per-contract arrays + 1-based index maps
  (swap-and-pop). Paginated reads: `getActiveListings(nft, offset, limit)`,
  `getActiveListings1155(...)` — no event-log scanning needed.
- Owner must `setApprovedContract(nft, true)` for MembersOnly and Items before
  they can be listed. Sellers must `setApprovalForAll(market, true)` first.

---

## 7. Contract 6 — `TraditionalGambling.sol` (ETH-backed, no NFT gate)

Standalone real-money chip house for non-NFT ("traditional") tables. **No
token gate, no free chips.**

- **`CHIP_PRICE = 0.005 ether`**, both directions. `buyChips()` (payable) and
  `cashOut(chips)` at the same rate.
- Internal ledger `chipBalance` + `totalChips`. **Solvency invariant:**
  `address(this).balance >= totalChips * CHIP_PRICE` holds after every state
  change. `_mintChips` asserts it; `withdrawHouse` can only take
  `houseSurplus()` (balance above the player reserve).
- `Ownable` + `ReentrancyGuard` + `Pausable`. `cashOut` is never paused so
  players can always exit.
- Same oracle settlement shape as Gamble: `resolveGame`,
  `commitWager`/`claimWinnings`, `cageBuyIn`/`cageCashOut` — but the signed
  message binds `address(this)` instead of a tokenId owner, e.g.
  `keccak256(player, wager, payout, gameId, nonce, address(this))`.
- House bankroll: `depositHouse()` (owner funds net payouts).

---

## 8. The authorization chain (wire it in THIS order)

Nothing works until these calls are made by the contract owner/deployer:

```
1. deploy MembersOnly(baseURI)
2. deploy MembersOnlyItems(baseURI, membersOnly)
3. deploy Gamble(membersOnly, items, ORACLE_ADDRESS)
4. deploy Tournament(membersOnly, items)
5. deploy Market(owner)
6. (optional) deploy TraditionalGambling(ORACLE_ADDRESS)

WIRING
  MembersOnly.setItems(items)                       // NFT knows where chips live
  MembersOnlyItems.setGameContract(membersOnly,true)// NFT may mint chips at mint
  MembersOnlyItems.setGameContract(gamble,true)     // Gamble may burn/mint chips
  MembersOnlyItems.setGameContract(tournament,true) // Tournament may burn entry chips
  MembersOnly.setGameContract(gamble,true)          // Gamble may setActive() a token
  Market.setApprovedContract(membersOnly,true)
  Market.setApprovedContract(items,true)

TIER ECONOMY (defaults already set in constructor; re-affirm to be explicit)
  MembersOnly.setTierReward(1,50)   // Common   — tournament chips/week
  MembersOnly.setTierReward(2,80)   // Rare
  MembersOnly.setTierReward(3,200)  // Legendary
  MembersOnly.batchSetTier([...ids], [...tiers])   // 90/9/1 to match metadata

HOUSE BANKROLL (required before real-money table payouts work)
  MembersOnlyItems.depositHouse{value: X AVAX}()   // funds regular-chip winnings
  // Without this, Gamble.claimWinnings / resolveGame revert "House underfunded"
  // because minting winning chips must keep the 0.05-AVAX peg fully backed.
```

`scripts/deployEverything.js` performs all of the above end-to-end and patches
`js/config.js` with the deployed addresses.

---

## 9. Off-chain layer — Cloudflare Worker + Durable Objects

### 9.1 `runner-worker.js` (HTTP router) — key endpoints

```
POST /craps/start        verify on-chain wager, mint HMAC session token
POST /craps/cashout       sign cage payout, mark nonce used (KV, 24h)
GET  /tables/list         public table presence
WS   /craps/ws            connect to a table Durable Object
POST /poker/start|deal|draw|cashout        video poker
     (+ hashcash / freeplay / pieface routes)
```

The Worker holds `ORACLE_PRIVATE_KEY` (a wrangler **secret**, never in
`wrangler.toml`) and is the **only** thing that signs payouts. It reads the
chain (`READ_RPC`) to confirm a wager was actually committed before crediting
an off-chain stack, and it marks nonces used in KV to prevent replay.

`wrangler.toml` bindings: `RUNNER_KV`, DOs `CRAPS_TABLE`, `HASHCASH_TABLE`,
`CLUBNILE_ROOM`; vars `CONTRACT_ADDRESS`, `GAMBLE_ADDRESS`, `READ_RPC`.

### 9.2 `ClubNileRoom` Durable Object — SHARED tables (the current design)

One DO instance per room name. `'lobby'` = casino-wide chat. `'craps'`,
`'roulette'`, `'blackjack'` = **shared, server-authoritative** table games.

**Core principle:** the server owns the random **outcome** and the **clock**;
each client owns its own chips and resolves its own bets/hand against the
shared outcome. This maps 1:1 onto `Gamble.commitWager` / oracle-signed
`claimWinnings`. **There is no solo mode** — a lone player still plays against
the server clock exactly as if others were there; an empty table resets.

**Phase machines (server-driven, `setTimeout`-based):**

```
craps:     betting(15s) → action(10s: shooter rolls, or table auto-rolls)
           → dice broadcast → outcome(9s) → betting …
roulette:  betting(15s) → server spins ONE number (Uint32 % 37) → outcome(7s) → …
blackjack: betting(15s) → server deals a shared dealer up-card → action(15s:
           players play their own hands) → server draws dealer to 17
           → outcome(7s) → …
```

**Wire protocol (JSON over WS):**

```
client→server: {t:'chat',text} {t:'emoji',e} {t:'tip',to,amount} {t:'roll'}
server→client: {t:'welcome',id,seat,roster,history,game}
               {t:'join',player} {t:'leave',id} {t:'full'}
               {t:'phase',phase,ms,...extra}          // extra: craps point/shooter,
                                                       //  roulette n, bj up/dealer
               {t:'dice',d:[a,b],point,seven,shooter}  // craps
               {t:'spin',n}                            // roulette
```

**Failsafes (verified):** max 4 seats/table (`{t:'full'}` + close when full);
first player to sit starts the clock; on the shooter leaving, craps rotates the
shooter and re-broadcasts; when the **last** player leaves, `resetGame()` clears
state so the next arrival starts fresh. Dice/cards use `crypto.getRandomValues`.

**Client mirror (in `giraffesanctuary.html`):** `cr.net` / `rou.net` /
`bj.net` adopt the server clock on `welcome`, animate to the shared
number / settle against the shared dealer, and show "WAITING FOR THE TABLE"
until the server phase is live.

### 9.3 Legacy DOs

`CrapsTable` (older single-game craps engine, HMAC anti-cheat, KV idle logs)
and `HashCashTable` still ship for the older Club Nile flow. New work uses
`ClubNileRoom`.

---

## 10. Front-end — `games/giraffesanctuary.html`

Single-file HTML5 canvas game (~6,000 lines), no build step.

- **Console shell:** a Gameboy-style frame PNG (832×1248, transparent screen
  cutout) with a power slider and an on/off toggle; overlays positioned as
  `%` of the frame; CSS `container-type` + `cqw` units.
- **Sprites:** procedural pixel-art via `makeCanvas(w,h,painter)` at 2× backing.
  `makeGiraffe(t)` builds giraffe characters (coat variety via `GIR_TONES`,
  ossicones/accessories via `ACC_HEAD`). NPCs and the player are giraffes.
- **Scenes:** `entry | floor | craps | blackjack | roulette | tourney`, with a
  camera `camY` for the tall floor. A west-wall portal under the cage leads to
  the **tournament room** (its own tables + a cage that dispenses tournament
  chips); currency swaps at the room boundary (`giraffe_chips` ↔ `giraffe_tchips`).
- **Audio:** single track `assets/membersonly/circleoflife.mp3`, autoplay +
  auto-unmute on first gesture; mute button hidden on the title card, shown
  once booted (`#btn-mute.live`).
- **Wallet:** ethers.js v5 + Reown/AppKit. All chip actions call the contracts
  in §2–§5; live tables talk to `ClubNileRoom` over WebSocket.
- **Casino name (first entry):** on wallet connect, `ensureCasinoName()` reads
  `isNameAssigned(tokenId)`. If named, it adopts `tokenName` as the player's
  identity; if not, a one-shot modal writes the chosen name to the NFT via
  `setName` (validated against `isNameTaken`). That name then drives chat, tips
  and the roster, and the chat name field is locked — `setName` is one-shot on
  the contract, so **names can never be changed**.
- **Round result messaging:** after each round every player is shown their
  total win/loss for that round.

Other pages: `mint.html` (mint + name + weekly claim), `tournament.html`,
market pages. **Every HTML page must carry the CSP meta tag** mandated in
`CLAUDE.md`.

---

## 11. Player lifecycle (end to end)

```
1. MINT      mint.html → MembersOnly.mint() (10 AVAX)   → ERC-721 + 50 TOURNAMENT chips
2. TIER      owner batchSetTier() to match metadata     → Common/Rare/Legendary
3. NAME      mint.html → MembersOnly.setName()          → ≤12-char unique name
4. CLAIM     mint.html → claimWeeklyChips(tokenId)      → 50/80/200 TOURNAMENT chips/week
5. BUY-IN    Items.buyChips() (0.05 AVAX each)          → REGULAR chips to gamble with
6. GAMBLE    gamble → Gamble.commitWager()/cageBuyIn()  → regular chips burned into session
7. PLAY      craps/roulette/blackjack via ClubNileRoom  → shared server outcomes
8. CASHOUT   Worker signs → Gamble.claimWinnings()/cageCashOut() → regular chips minted back
9. REDEEM    Items.redeemChips()                        → regular chips → 0.05 AVAX each
10. TOURNEY  Tournament.enterTournament()/lockScore()   → burns tournament chips
             → owner fundPrizePool + setPrizeWeights + settleTournament → top locks win the yield
11. TRADE    Market.list()/buy() and free ERC-1155 chip transfers
```

---

## 12. Deployment & ops runbook

**The user cannot run code locally.** Everything runs through the
**`Deploy` GitHub Actions workflow** (`.github/workflows/deploy.yml`,
`workflow_dispatch`) with inputs `network` (`fuji`|`avalanche`) and `target`:

| target | effect |
|--------|--------|
| `everything` | deploy all contracts + wire + worker |
| `all-contracts` | MembersOnly + Items only |
| `gamble` | Gamble only |
| `worker` | Cloudflare Worker only |
| `authorize` | re-run the authorization chain |
| `approve-market` | whitelist MembersOnly + Items on Market |
| `verify` / `validate` | Snowtrace verify / on-chain wiring check |
| `reset-tables` | nuke stuck craps game state |

Required GitHub secrets: `DEPLOYER_PRIVATE_KEY`, `ORACLE_ADDRESS`,
`ORACLE_PRIVATE_KEY`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `AGORA_APP_CERT`,
`KV_NAMESPACE_ID`, `KV_PREVIEW_ID`, `SNOWTRACE_API_KEY`.

> **CRITICAL (from CLAUDE.md):** never run a contract-deploy script without
> explicit user confirmation — testnet or mainnet. Push all site changes
> **directly to `main`** (never the create-main force-push workflow, which
> would clobber user-uploaded assets).

**Ordering gotcha:** a client build that removes solo play must not reach
`main` before the matching **worker** deploy — otherwise the shared tables have
no server to drive them and hang on "WAITING FOR THE TABLE." Deploy the worker
first, confirm green, then push the client.

---

## 13. Rebuild-from-zero checklist

1. `contracts/` — port the six contracts (Solidity 0.8.26, OZ v5). Keep: the
   tier constants + constructor defaults (50/80/200) and the 1–3 tier range;
   `MINT_PRICE = 10 ether`; the two-token split (regular chips token 0 pegged at
   `CHIP_PRICE = 0.05 ether` with the backing invariant + buy/redeem/house
   bankroll; tournament chips token 1 free/prize-only); weekly drop + welcome
   bonus + item perks all mint **tournament** chips; tournament entry burns
   **tournament** chips; Gamble settles **regular** chips.
2. `hardhat.config.js` — compiler 0.8.26 (optimizer 200), Fuji + Avalanche nets.
3. `scripts/deployEverything.js` — deploy + full §8 wiring + tier rewards +
   patch `js/config.js`.
4. `worker/` — `runner-worker.js` router, `clubnile-room.js` DO, `wrangler.toml`
   (KV + DO bindings + `CONTRACT_ADDRESS`/`GAMBLE_ADDRESS`/`READ_RPC` vars);
   set `ORACLE_PRIVATE_KEY` as a secret. Oracle signing scheme per §4/§7.
5. `games/giraffesanctuary.html` — canvas game with the `cr.net`/`rou.net`/
   `bj.net` shared-table client mirroring the DO protocol in §9.2. CSP meta tag.
6. `.github/workflows/deploy.yml` — `workflow_dispatch` with the §12 targets +
   the listed secrets.
7. Wire, set tiers (90/9/1), fund the Items house bankroll (`depositHouse`) and
   Tournament prize pools (`fundPrizePool`) as needed, and verify with
   `target: validate`.

---

*Last updated: 2026-07-12. Reflects: the 3-tier rarity model (Common 90 %/50,
Rare 9 %/80, Legendary 1 %/200, paid in tournament chips; welcome bonus =
rarity amount, unset tier → Common); no partner-NFT chip bonus; the
two-currency economy (regular chips = 0.05 AVAX real money, token 0; tournament
chips = free/prize-only, token 1); owner tournament-chip airdrops + item perks;
10 AVAX mint price; rank-based tournament yield/prize settlement
(fundPrizePool / setMinLockToQualify / setPrizeWeights / settleTournament) as
the ONLY yield mechanism — the old chip-burn treasury/share vault was removed,
and nothing burns AVAX anywhere; and the shared server-authoritative tables.*
