# plan.md — Going Live on Avalanche C-Chain

**The user cannot code or run code locally.** All scripts, deployments, and commands must be written by Claude, committed to the repo, and executed via GitHub Actions workflows.

---

## !!!!! NEVER DEPLOY CONTRACTS WITHOUT ASKING !!!!!

---

## Overview

Transition Last Chad from Fuji testnet to Avalanche mainnet. Deploy all existing contracts + one new Tournament contract. Update all addresses, RPC endpoints, and worker config across the entire project.

**Supply:** 333 NFTs
**Mint Price:** 2 AVAX (flat, no discounts)

---

## 1. Contract Changes

### LastChad.sol — Minting Changes

**Remove:**
- `TEAM_MINT_PRICE` constant — no discount pricing
- `mintWithTeam()` function — removed entirely
- `tokenTeam` mapping — NFTs are not assigned to teams
- `teamMemberCount` mapping — not needed

**Modify `_mintInternal()`:**
- Base cells per mint: **25** (currently 5)
- Partner bonus: If minter holds an NFT from any registered partner collection, award **100 extra cells** (checked at mint time only, not retroactive)
- Total possible: **125 cells** per mint (25 base + 100 partner bonus)
- Partner collections still registered via `createTeam()` (rename to `registerPartner()`) — only used to check `balanceOf > 0` for the bonus

**Keep:**
- `teams` mapping (rename to `partners`) — still needed to register partner NFT contract addresses
- `createTeam()` → rename to `registerPartner()` — owner registers partner collection addresses
- The `balanceOf(partnerContract) > 0` check — used for bonus cell check at mint

### LastChad.sol — Add Level Freeze

Add a one-way `freezeLevels()` function that permanently stops leveling:

```
bool public levelsFrozen;

function freezeLevels() external onlyOwner {
    levelsFrozen = true;
}
```

Modify `lockCells()`:
- When `levelsFrozen == true`: cells still lock (closedCells increases), but skip the leveling logic — no `_pendingStatPoints`, no `LevelUp` event

Modify `spendStatPoint()`:
- Revert if `levelsFrozen == true`

### New Contract: Tournament.sol

Manages the monthly endgame craps tournament cycle.

**State:**
```
ILastChad public immutable lastChad;
address public immutable gameOwner;
uint256 public currentMonth;
uint256 public constant LOCK_AMOUNT = 1111;

mapping(uint256 => uint256) public endgameSnapshot;     // tokenId → closed cells at endgame (permanent)
mapping(uint256 => uint256) public cellTiers;            // closedCellThreshold → claimAmount
uint256[] public tierThresholds;                         // sorted thresholds for lookup
mapping(uint256 => mapping(uint256 => bool)) public cellsClaimed;    // tokenId → month → claimed
mapping(uint256 => mapping(uint256 => bool)) public lockedForMonth;  // tokenId → month → locked
mapping(uint256 => uint256) public lockCount;            // month → number of chads who locked
mapping(uint256 => uint256[]) public lockedChads;        // month → array of tokenIds who locked
```

**Setup Functions (owner):**
```
snapshotEndgame(uint256[] tokenIds, uint256[] closedCells)
  — One-time call. Freezes each chad's closed cell count for tier lookup.
  — Can be called in batches if needed.

setCellTier(uint256 closedCellThreshold, uint256 claimAmount)
  — Sets how many free cells a chad gets based on their snapshot.
  — Example: threshold 500 → 30 cells, threshold 1000 → 50 cells, etc.

batchSetCellTiers(uint256[] thresholds, uint256[] amounts)
  — Set multiple tiers in one call.
```

**Player Functions (website buttons):**
```
claimCells(uint256 tokenId)
  — Requires: ownerOf(tokenId) == msg.sender
  — Requires: !eliminated(tokenId)
  — Requires: !cellsClaimed[tokenId][currentMonth]
  — Looks up endgameSnapshot[tokenId], finds matching tier
  — Calls lastChad.awardCells(tokenId, tierAmount)
  — Marks cellsClaimed[tokenId][currentMonth] = true

lockForTournament(uint256 tokenId)
  — Requires: ownerOf(tokenId) == msg.sender
  — Requires: !eliminated(tokenId)
  — Requires: !lockedForMonth[tokenId][currentMonth]
  — Calls lastChad.spendCells(tokenId, 1111)  ← burns 1111 open cells
  — Marks lockedForMonth[tokenId][currentMonth] = true
  — Increments lockCount[currentMonth]
  — Pushes tokenId to lockedChads[currentMonth]
```

**Owner Functions (GitHub workflow button):**
```
distributeAndReset() external payable onlyGameOwner
  — Snapshots address(this).balance as this month's yield pool
  — Reads lockedChads[currentMonth] to get winner list
  — Calculates perWinner = yieldPool / lockCount (rounded down)
  — Loops through winners, sends AVAX to ownerOf(tokenId)
  — Increments currentMonth (resets claims & locks for next cycle)

receive() external payable
  — Accepts raw AVAX transfers (owner deposits yield)
```

**View Functions (for website/leaderboard):**
```
getLockedChads(uint256 month) → uint256[]        — who locked 1111 this month
getLockCount(uint256 month) → uint256             — how many locked
hasClaimed(uint256 tokenId, uint256 month) → bool — did this chad claim cells
hasLocked(uint256 tokenId, uint256 month) → bool  — did this chad lock 1111
getClaimAmount(uint256 tokenId) → uint256         — cells this chad would get
getCurrentMonth() → uint256                       — current tournament month
```

**Authorization:**
- Must call `lastChad.setGameContract(tournamentAddress, true)` after deploy
- Tournament contract calls `lastChad.awardCells()` for cell claims
- Tournament contract calls `lastChad.spendCells()` for 1111 locks

### Gamble.sol, QuestRewards.sol, LastChadItems.sol, Market.sol

**No changes needed.** Redeploy as-is to mainnet.

---

## 2. Files That Need Address/Network Updates

When contracts are deployed to mainnet, new addresses must be updated in:

| File | What to update |
|------|---------------|
| `js/config.js` | All 5 contract addresses + `READ_RPC` → mainnet + add `TOURNAMENT_ADDRESS` |
| `js/quest-globals.js` | Contract addresses, RPC URLs, chain ID (`0xa86a` / 43114), network name, block explorer |
| `js/wallet.js` | Chain ID → `0xa86a`, RPC → mainnet, network name, block explorer |
| `worker/wrangler.toml` | All contract addresses + `READ_RPC` → mainnet + add `TOURNAMENT_ADDRESS` |
| `hardhat.config.js` | Already has mainnet config — no changes needed |
| `github-api.js` | Embedded quest chain config: chain ID, RPC, network name |
| `gamble.html` | Uses addresses from config — verify imports |
| `craps.html` | Uses addresses from config — verify imports |
| `CLAUDE.md` | Update deployed addresses section |

**Quest pages** (`quests/*/index.html`) have hardcoded chain config. These are generated by `github-api.js`, so updating `github-api.js` and regenerating quests handles them.

### Network Config Changes

| Setting | Fuji (current) | Mainnet (target) |
|---------|---------------|-----------------|
| Chain ID | `43113` / `0xa869` | `43114` / `0xa86a` |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` | `https://api.avax.network/ext/bc/C/rpc` |
| Explorer | `https://testnet.snowtrace.io/` | `https://snowtrace.io/` |
| Network name | `Avalanche Fuji Testnet` | `Avalanche C-Chain` |

---

## 3. Deployment Workflow

**One GitHub Actions workflow: `deploy.yml` (already exists, needs updates)**

The existing `deploy.yml` already supports network selection (fuji/avalanche). It needs to be updated to:

1. Deploy all 6 contracts (add Tournament.sol)
2. Run authorization calls (`setGameContract` for QuestRewards, Gamble, and Tournament on both LastChad and LastChadItems)
3. Update `js/config.js` with new addresses
4. Update `worker/wrangler.toml` with new addresses
5. Redeploy Cloudflare Worker with new config
6. Commit updated addresses back to the repo

### Deploy Order (dependencies matter)

```
1. Deploy LastChad.sol          → get LASTCHAD_ADDRESS
2. Deploy LastChadItems.sol     → get ITEMS_ADDRESS
3. Deploy QuestRewards.sol(lastChad, items, oracle)  → get QUESTREWARDS_ADDRESS
4. Deploy Gamble.sol(lastChad, oracle)               → get GAMBLE_ADDRESS
5. Deploy Market.sol(lastChad, items)                → get MARKET_ADDRESS
6. Deploy Tournament.sol(lastChad)                   → get TOURNAMENT_ADDRESS
7. Authorize: lastChad.setGameContract(questRewards, true)
8. Authorize: lastChad.setGameContract(gamble, true)
9. Authorize: lastChad.setGameContract(tournament, true)
10. Authorize: lastChadItems.setGameContract(questRewards, true)
11. Update js/config.js with all 6 addresses
12. Update worker/wrangler.toml with all addresses
13. Redeploy Cloudflare Worker
14. Commit & push updated files
```

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `DEPLOYER_PRIVATE_KEY` | Wallet that deploys contracts (becomes owner) |
| `ORACLE_PRIVATE_KEY` | Oracle key for signing rewards/payouts |
| `CF_API_TOKEN` | Cloudflare API token for worker deployment |
| `CF_ACCOUNT_ID` | Cloudflare account ID |

### Post-Deploy Verification

The workflow should also run `scripts/validateContracts.js` to verify:
- All contracts deployed and responding
- Authorization chain is set correctly
- Oracle addresses match
- Supply and mint price are correct

---

## 4. Tournament Payout Workflow

**New workflow: `tournament-payout.yml` (manual trigger)**

One button that does everything:

```yaml
on:
  workflow_dispatch:
```

**Script logic:**
1. Read `Tournament.getLockedChads(currentMonth)` — get winner token IDs
2. Read `Tournament.getLockCount(currentMonth)` — get winner count
3. Read contract AVAX balance
4. Calculate per-winner payout (rounded to 2 decimal places)
5. Log results (winner list, payout amounts)
6. Call `Tournament.distributeAndReset()` — sends AVAX, advances month

**Output:** Workflow logs show which chads won, how much each received, new month number.

---

## 5. Endgame Activation Workflow

**New workflow: `activate-endgame.yml` (manual trigger, one-time use)**

Run after the cull is complete and 100 chads remain:

1. Call `LastChad.freezeLevels()` — permanently lock all levels
2. Read closed cells for all 100 alive chads
3. Call `Tournament.snapshotEndgame(tokenIds, closedCells)` — freeze tiers
4. Set cell tier brackets via `Tournament.batchSetCellTiers(thresholds, amounts)`

**This is irreversible. Workflow should require confirmation.**

---

## 6. Website Pages Needed

| Page | Purpose |
|------|---------|
| `tournament.html` | Leaderboard: which chads locked 1111 this month, claim cells button, lock 1111 button |

Tournament page reads from Tournament contract view functions. No backend needed — all on-chain reads.

---

## 7. Checklist — Going Live

- [ ] Finalize LastChad.sol changes (freezeLevels)
- [ ] Write Tournament.sol
- [ ] Write tests for both
- [ ] Update deploy.yml to include Tournament
- [ ] Create tournament-payout.yml workflow
- [ ] Create activate-endgame.yml workflow
- [ ] Test full deploy on Fuji first
- [ ] **ASK USER before deploying to mainnet**
- [ ] Deploy all contracts to Avalanche C-Chain
- [ ] Verify contracts on Snowtrace
- [ ] Update all addresses across project
- [ ] Redeploy Cloudflare Worker with mainnet config
- [ ] Update all frontend chain configs to mainnet
- [ ] Regenerate quest pages with mainnet config
- [ ] Build tournament.html page
- [ ] Test everything end-to-end on mainnet
