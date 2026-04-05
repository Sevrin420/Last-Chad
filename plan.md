# plan.md — Going Live on Avalanche C-Chain

**The user cannot code or run code locally.** All scripts, deployments, and commands must be written by Claude, committed to the repo, and executed via GitHub Actions workflows.

---

## !!!!! NEVER DEPLOY CONTRACTS WITHOUT ASKING !!!!!

---

## Overview

Deploy Last Chad directly to Avalanche mainnet. All 6 contracts deploy in a single workflow via `deployEverything.js`.

**Supply:** 333 NFTs
**Mint Price:** 2 AVAX (flat, no discounts)
**Base Cells:** 50 per NFT at mint
**Max Cells per Mint:** 250 (50 base + 100 partner + 100 code)

---

## 1. Contract Changes (DONE)

### LastChad.sol — Completed Changes

**Removed:**
- `TEAM_MINT_PRICE` constant
- `mintWithTeam()` function
- `tokenTeam` mapping
- `teamMemberCount` mapping

**Added:**
- `BASE_CELLS = 50`, `PARTNER_BONUS_CELLS = 100`, `CODE_BONUS_CELLS = 100`
- `mintWithCode(uint256 quantity, string calldata code)` — mint with a bonus code for +100 cells/NFT
- Partner system: `registerPartner()`, `setPartnerActive()`, `hasPartnerNFT()` — replaces team system
- Mint code system: `addMintCodes()`, `removeMintCode()`, `mintCodeValid`, `mintCodeUsed` — one-time-use codes, stored as keccak256 hashes
- `freezeLevels()` — one-way permanent level freeze for endgame transition
- `lockCells()` skips leveling when `levelsFrozen == true`
- `spendStatPoint()` reverts when `levelsFrozen == true`

**Cell breakdown per NFT:**
| Source | Cells | Condition |
|--------|-------|-----------|
| Base | 50 | Always |
| Partner NFT | +100 | Minter holds a registered partner collection NFT |
| Mint code | +100 | Valid one-time-use code entered at mint |
| **Total max** | **250** | All three |

### Tournament.sol — New Contract (DONE)

Manages the monthly endgame craps tournament cycle.

**State:**
```
ILastChad public immutable lastChad;
uint256 public currentMonth;
uint256 public constant LOCK_AMOUNT = 1111;

mapping(uint256 => uint256) public endgameSnapshot;
mapping(uint256 => uint256) public cellTiers;
uint256[] public tierThresholds;
mapping(uint256 => mapping(uint256 => bool)) public cellsClaimed;
mapping(uint256 => mapping(uint256 => bool)) public lockedForMonth;
mapping(uint256 => uint256) public lockCount;
mapping(uint256 => uint256[]) public lockedChads;
```

**Player Functions:**
- `claimCells(tokenId)` — claim free monthly cells based on endgame tier
- `lockForTournament(tokenId)` — burn 1111 open cells to enter monthly payout

**Owner Functions:**
- `snapshotEndgame(tokenIds, closedCells)` — freeze endgame cell counts
- `setCellTier() / batchSetCellTiers()` — set cell claim tiers
- `distributeAndReset()` — distribute AVAX to locked chads, advance month

**View Functions:**
- `getLockedChads(month)`, `getLockCount(month)`, `hasClaimed(tokenId, month)`
- `hasLocked(tokenId, month)`, `getClaimAmount(tokenId)`, `getCurrentMonth()`

### Gamble.sol, QuestRewards.sol, LastChadItems.sol, Market.sol

**No changes needed.** Redeploy as-is to mainnet.

---

## 2. Mint Codes (DONE)

- 100 one-time-use alphanumeric codes generated (format: `CHAD-XXXX-XXXX`)
- Hashes stored in `scripts/mintcodes-hashes.json`
- `deployEverything.js` loads all 100 hashes on-chain automatically during deploy
- Standalone loading via `scripts/loadMintCodes.js` + `load-mintcodes` deploy target
- Plaintext codes given to owner for distribution to partner communities
- `mint.html` has code input field with live validation + cell breakdown preview

---

## 3. Files That Need Address/Network Updates

When contracts are deployed to mainnet, `deployEverything.js` automatically patches:
- `js/config.js` — all 6 contract addresses
- `js/quest-globals.js` — 3 contract addresses
- `worker/wrangler.toml` — 3 contract addresses + RPC

**Manual updates still needed after deploy:**

| File | What to update |
|------|---------------|
| `js/config.js` | `READ_RPC` → mainnet, `AVAX_CHAIN_ID` → `0xa86a`, chain config |
| `js/quest-globals.js` | Chain ID, RPC URLs, network name, block explorer |
| `js/wallet.js` | Chain ID → `0xa86a`, RPC → mainnet, network name |
| `github-api.js` | Embedded quest chain config |
| `mint.html` | Snowtrace link → mainnet |
| `CLAUDE.md` | Update deployed addresses + constants |

### Network Config Changes

| Setting | Fuji (current) | Mainnet (target) |
|---------|---------------|-----------------|
| Chain ID | `43113` / `0xa869` | `43114` / `0xa86a` |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` | `https://api.avax.network/ext/bc/C/rpc` |
| Explorer | `https://testnet.snowtrace.io/` | `https://snowtrace.io/` |
| Network name | `Avalanche Fuji Testnet` | `Avalanche C-Chain` |

---

## 4. Deployment Workflow (DONE)

**deploy.yml** — select `everything` target + `avalanche` network.

The `deployEverything.js` script handles the full deploy:
```
1. Deploy LastChad.sol          → get LASTCHAD_ADDRESS
2. Deploy LastChadItems.sol     → get ITEMS_ADDRESS
3. Deploy QuestRewards.sol      → get QUESTREWARDS_ADDRESS
4. Deploy Market.sol            → get MARKET_ADDRESS
5. Deploy Gamble.sol            → get GAMBLE_ADDRESS
6. Deploy Tournament.sol        → get TOURNAMENT_ADDRESS
7. Authorize: lastChad.setGameContract(questRewards, true)
8. Authorize: lastChad.setGameContract(gamble, true)
9. Authorize: lastChad.setGameContract(tournament, true)
10. Authorize: lastChadItems.setGameContract(questRewards, true)
11. Market: approve LastChad + Items
12. Set oracle on QuestRewards
13. Seed quest config (quest 1 → 10 cells)
14. Load 100 mint code hashes
15. Patch js/config.js, js/quest-globals.js, worker/wrangler.toml
16. Commit & push updated files
```

### Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `DEPLOYER_PRIVATE_KEY` | Wallet that deploys contracts (becomes owner) |
| `ORACLE_ADDRESS` | Oracle wallet public address |
| `ORACLE_PRIVATE_KEY` | Oracle private key (stored in Worker) |
| `CF_API_TOKEN` | Cloudflare API token |
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `SNOWTRACE_API_KEY` | Snowtrace verification API key |

### Post-Deploy Verification

Run `validate` target in deploy.yml to confirm:
- All contracts deployed and responding
- Authorization chain is set correctly
- Oracle addresses match
- Supply and mint price are correct

---

## 5. Tournament Payout Workflow (DONE)

**`tournament-payout.yml`** — manual trigger, runs `scripts/tournamentPayout.js`:
1. Read locked chads and prize pool balance
2. Calculate per-winner payout
3. Call `Tournament.distributeAndReset()` — sends AVAX, advances month

---

## 6. Endgame Activation Workflow (DONE)

**`activate-endgame.yml`** — manual trigger, requires typing "ACTIVATE":
1. Call `LastChad.freezeLevels()` — permanently lock all levels
2. Read closed cells for all alive chads
3. Call `Tournament.snapshotEndgame()` — freeze tiers
4. Set default cell tier brackets via `batchSetCellTiers()`

**This is irreversible.**

---

## 7. Website Pages (DONE)

| Page | Status | Purpose |
|------|--------|---------|
| `mint.html` | Updated | Code input, partner detection, live cell breakdown |
| `tournament.html` | New | Claim cells, lock 1111, leaderboard |

---

## 8. Game Phase Transitions

### Phase 1: Mint & Quest (launch → cull begins)
- Players mint NFTs (333 max, 2 AVAX each)
- Complete quests for cells + XP
- Level up and allocate stat points
- Gamble cells in craps

**Owner actions:** Register partner NFT collections, distribute mint codes

### Phase 2: Cull (periodic eliminations)
- Owner announces culls via `announceCull()`
- Eliminated chads lose access to quests/craps
- Continues until ~100 chads remain

**Owner actions:**
1. `setCullMode()` — set cull percentage or fixed count
2. `announceCull(executeAfterTimestamp)` — announce with delay
3. `batchEliminate(tokenIds)` — execute cull (bottom N by closed cells)

### Phase 3: Endgame (tournaments begin)
**Trigger:** Run `activate-endgame.yml` workflow (type "ACTIVATE")

This permanently:
1. Freezes all levels (no more stat points)
2. Snapshots each surviving chad's closed cells
3. Sets cell tier brackets for monthly claims

**After activation:**
- Surviving chads claim free monthly cells based on their endgame tier
- Lock 1111 cells to enter monthly craps tournament
- Owner deposits AVAX yield into Tournament contract
- Run `tournament-payout.yml` monthly to distribute AVAX to locked chads

### Phase 4: Final Chad (eventual endgame)
When supply reaches 1 surviving chad, that wallet owns everything.

**Details TBD — see Section 10 (Future Features).**

---

## 9. Checklist — Going Live

### Done
- [x] Update LastChad.sol (freezeLevels, mint codes, 50 base cells, 250 max, partner system)
- [x] Write Tournament.sol
- [x] Write tests for both
- [x] Generate 100 mint codes + hashes
- [x] Update deployEverything.js for all 6 contracts + mint codes
- [x] Update deploy.yml with `everything` target
- [x] Create tournament-payout.yml workflow
- [x] Create activate-endgame.yml workflow
- [x] Update mint.html (code input, cell breakdown, 2 AVAX price)
- [x] Build tournament.html page
- [x] Update config.js ABIs (removed team, added partner/code/freeze/tournament)

### Pre-Deploy
- [ ] Switch all frontend chain configs to mainnet (config.js, wallet.js, quest-globals.js)
- [ ] Update Snowtrace links to mainnet
- [ ] Register partner NFT collections (if any at launch)
- [ ] **ASK USER before deploying to mainnet**

### Deploy
- [ ] Run `everything` target on `avalanche` network
- [ ] Redeploy Cloudflare Worker with `fix-worker` target
- [ ] Verify contracts on Snowtrace with `verify` target
- [ ] Validate contracts on-chain with `validate` target
- [ ] Update CLAUDE.md with new addresses

### Post-Deploy
- [ ] Regenerate quest pages with mainnet config (via github-api.js)
- [ ] Test minting end-to-end on mainnet
- [ ] Test craps end-to-end on mainnet
- [ ] Distribute mint codes to partner communities

---

## 10. Future Features (Discuss Before Executing)

> These ideas have been approved in concept but need full design discussion before any code is written.

### Stat-Based Quest Gating
Certain quests require minimum stats. High level Chads access higher yield quests.

### Public Xphar Treasury Dashboard
Live page showing yield accumulating in real time + projected prize pool.

### Spectator Mode
Watch live craps tables without playing.

### Rival System
Players mark another Chad as a rival. Track head-to-head craps outcomes.

### The Final Chad
When supply reaches 1 surviving Chad, that wallet owns the entire treasury forever.
