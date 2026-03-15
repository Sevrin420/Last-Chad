# update.md Implementation Plan — Step-by-Step

## Phase 1: LastChad.sol Core Changes (Foundation — everything depends on this)

### Step 1.1 — Constants & Inheritance
- `MAX_SUPPLY` 70 → 10,000
- `MINT_PRICE` 0.02 ether → 2 ether
- `MAX_MINT_PER_WALLET` 5 → TBD (ask user — whales minting 50 is fine per update.md)
- Add `ERC721Enumerable` to inheritance chain
- Add `supportsInterface` override for ERC721Enumerable
- Update `mint()` to work with ERC721Enumerable's `_update` hook

### Step 1.2 — Remove XP System
- Delete `_tokenExperience` mapping (if it exists — agents show `awardCells`/`spendCells` but no explicit `_tokenExperience`; verify)
- Delete `awardExperience()` function
- Delete `getExperience()` function
- Keep `getLevel()` — already returns `closedCells / 100 + 1`
- Keep `spendStatPoint()` and `_pendingStatPoints` — leveling still triggers from `lockCells()`

### Step 1.3 — Add `isActive` Flag (replaces escrow)
- Add `mapping(uint256 => bool) public isActive`
- Add `function setActive(uint256 tokenId, bool active) external onlyGameOrOwner`
- QuestRewards will call `setActive(true)` on quest start, `setActive(false)` on quest end
- NFT never leaves the player's wallet

### Step 1.4 — Per-Token Mutable URI
- Add `mapping(uint256 => string) private _tokenURIs`
- Override `tokenURI()` to check `_tokenURIs[tokenId]` first, fall back to `_baseTokenURI + tokenId`
- Add `setTokenURI(uint256 tokenId, string memory uri) external onlyOwner`
- Add `batchSetTokenURI(uint256[] calldata tokenIds, string[] calldata uris) external onlyOwner`
- Used for: dynamic metadata during game, survivor art at endgame, "Thanks for Playing" post-game

### Step 1.5 — Culling Helper
- Add `getClosedCellsBatch(uint256[] calldata tokenIds) external view returns (uint256[] memory)` — lets the culling script efficiently rank all players

### Step 1.6 — Update ILastChad Interface (used by QuestRewards/Gamble)
- Add `isActive(uint256) → bool`
- Add `setActive(uint256, bool)`
- `eliminated(uint256) → bool` already exists

**Depends on:** Nothing. This is the foundation.

---

## Phase 2: QuestRewards.sol Rewrite (Depends on Phase 1)

### Step 2.1 — Strip Escrow System
Delete all of the following:
- `lockedBy` mapping
- `_lockedTokenIds` array + `_lockedIndex` mapping
- `_addLocked()` / `_removeLocked()` internal helpers
- `burnLocked()` / `batchBurnLocked()` / `burnAllLocked()`
- `releaseLocked()` / `batchReleaseLocked()`
- `_doRelease()` / `_doBurn()`
- `BURN_ADDRESS` constant
- `onERC721Received()` — contract no longer receives NFTs
- `getLockedTokenIds()` / `getLockedCount()` views
- All `NFTBurned` / `NFTReleased` events

### Step 2.2 — Rewrite `startQuest()`
Old: transfers NFT to contract, generates seed, stores session
New:
```
startQuest(tokenId, questId):
  require ownerOf(tokenId) == msg.sender
  require !eliminated(tokenId)
  require !lastChad.isActive(tokenId)    ← replaces escrow check
  lastChad.setActive(tokenId, true)      ← flag, no transfer
  generate seed (same keccak256 logic)
  store QuestSession
  emit QuestStarted
```

### Step 2.3 — Rewrite `completeQuest()`
Old: returns NFT to player, awards XP
New:
```
completeQuest(tokenId, questId, cellReward, oracleSig):
  require session.active, correct questId, not expired
  verify oracle signature
  lastChad.setActive(tokenId, false)     ← unflag
  lastChad.awardCells(tokenId, cellReward)  ← cells, not XP
  if questConfig has itemReward: mint item
  delete session
  emit QuestCompleted
```

### Step 2.4 — Rewrite Quest Failure
Old: NFT stays locked, can be burned or released
New:
```
failQuest(tokenId, questId):
  require session.active, correct questId
  lastChad.setActive(tokenId, false)   ← just unflag
  delete session
  emit QuestFailed
  // No NFT burn. Death only comes from arcade minigames.
```

### Step 2.5 — Remove One-Attempt-Ever Limit
Old: `questStarted[tokenId][questId]` set permanently — one attempt per quest per token, ever
New: Replace with monthly cooldown or per-period tracking:
- Option A: `mapping(uint256 => mapping(uint8 => uint256)) public lastQuestTime` — cooldown-based
- Option B: `mapping(uint256 => mapping(uint8 => mapping(uint256 => bool))) public questAttempted` — keyed by period/month
- **Recommend Option A** (simpler): `require(block.timestamp >= lastQuestTime[tokenId][questId] + QUEST_COOLDOWN)`
- `QUEST_COOLDOWN` configurable by gameOwner (default: 30 days)

### Step 2.6 — Add Arcade Session Management
New struct:
```solidity
struct ArcadeSession {
    bytes32 seed;       // server-generated seed for obstacle patterns
    uint8   gameType;   // 0=runner, 1=topshooter, 2=area51
    uint40  startTime;
    bool    active;
}
mapping(uint256 => ArcadeSession) public arcadeSessions;
```

New functions:
- `startArcade(uint256 tokenId, uint8 gameType, bytes32 seed) external onlyGameOwner` — Worker calls after session setup
- `confirmSurvival(uint256 tokenId) external onlyGameOwner` — Worker confirms 2-min survival, clears arcade session
- `confirmDeath(uint256 tokenId) external onlyGameOwner` — Worker confirms death after anti-cheat validation, calls `lastChad.eliminate(tokenId)`

### Step 2.7 — Death Rate Limiter
```solidity
uint256 public deathCount;
uint256 public deathWindowStart;
uint256 public constant MAX_DEATHS_PER_WINDOW = 10;
uint256 public constant DEATH_WINDOW = 60; // seconds
bool public deathsPaused;

function confirmDeath(uint256 tokenId) external onlyGameOwner {
    require(!deathsPaused, "Deaths paused");
    if (block.timestamp > deathWindowStart + DEATH_WINDOW) {
        deathCount = 0;
        deathWindowStart = block.timestamp;
    }
    deathCount++;
    require(deathCount <= MAX_DEATHS_PER_WINDOW, "Too many deaths — auto-paused");
    // ... eliminate logic
}

function unpauseDeaths() external onlyGameOwner { deathsPaused = false; }
```

### Step 2.8 — Update Events
- Remove: `NFTBurned`, `NFTReleased`
- Add: `ArcadeStarted(uint256 indexed tokenId, uint8 gameType, bytes32 seed)`
- Add: `ArcadeSurvived(uint256 indexed tokenId, uint8 gameType)`
- Add: `ArcadeDeath(uint256 indexed tokenId, uint8 gameType)`
- Add: `QuestFailed(uint256 indexed tokenId, uint8 questId)`
- Keep: `QuestStarted`, `QuestCompleted`, `CellsAwarded`, `ItemAwarded`, `ItemPurchased`

**Depends on:** Phase 1 (needs `isActive`, `setActive`, updated interface)

---

## Phase 3: Gamble.sol Verification (Depends on Phase 1)

### Step 3.1 — Verify Elimination Checks
- Confirm `flip()` checks `!eliminated(tokenId)` ✓ (already does)
- Confirm `resolveGame()` checks `!eliminated(tokenId)` ✓
- Confirm `commitWager()` checks `!eliminated(tokenId)` ✓
- Confirm `claimWinnings()` checks — may need to add if missing

### Step 3.2 — Verify `isActive` Check
- Add: `require(!lastChad.isActive(tokenId))` to `flip()` and `commitWager()` — can't gamble while in a quest/arcade session
- Or: allow gambling during quests (design decision — ask user)

**Depends on:** Phase 1 (needs `isActive` in interface)

---

## Phase 4: Tests (Depends on Phases 1-3)

### Step 4.1 — Update LastChad.test.js
- Update all mint tests for new constants (supply=10000, price=2 AVAX, wallet limit)
- Add tests for `ERC721Enumerable` (tokenOfOwnerByIndex, totalSupply enumerable)
- Add tests for `isActive` flag (set/unset, only game contract can call)
- Add tests for `setTokenURI` / `batchSetTokenURI` (per-token override, fallback to base)
- Add tests for `getClosedCellsBatch`
- Remove any XP/experience tests (if they exist)
- Keep all cells/leveling/stat tests (unchanged logic)

### Step 4.2 — Rewrite QuestRewards.test.js
- Remove all escrow tests (NFT transfer, lockedBy, burn, release)
- Add tests for new `startQuest` (sets isActive, no NFT transfer)
- Add tests for new `completeQuest` (clears isActive, awards cells not XP)
- Add tests for `failQuest` (clears isActive, no death)
- Add tests for quest cooldown (replaces one-attempt-ever)
- Add tests for `startArcade` / `confirmSurvival` / `confirmDeath`
- Add tests for death rate limiter (10 deaths in 60s triggers pause)
- Add tests for `unpauseDeaths`

### Step 4.3 — Gamble.test.js
- Add tests for eliminated Chads being blocked from all gambling functions
- Add tests for isActive Chads being blocked (if we add that check)

### Step 4.4 — Integration Tests
- Full flow: mint → start quest → complete quest → earn cells → lock cells → verify level
- Full flow: mint → start arcade → survive → cells awarded
- Full flow: mint → start arcade → die → eliminated → can't quest/gamble
- Culling flow: multiple tokens → getClosedCellsBatch → batchEliminate bottom N%

**Depends on:** Phases 1-3 (contracts must compile first)

---

## Phase 5: Deploy Scripts (Depends on Phases 1-3)

### Step 5.1 — Update `deployLastChad.js`
- Update constructor args if any changed
- Handle ERC721Enumerable
- Verify new functions exist in ABI

### Step 5.2 — Update `deployQuestRewards.js`
- Remove ERC721 receiver setup
- Remove lockedBy/burn/release references
- Add arcade-related config if needed

### Step 5.3 — Update `deployAll.js`
- Ensure authorization chain works with new function signatures
- `setGameContract` calls for QuestRewards in both LastChad and LastChadItems

**Depends on:** Phases 1-3

---

## Phase 6: Frontend — Config & Constants (Depends on Phases 1-3)

### Step 6.1 — js/config.js
- Update `LASTCHAD_ABI`: add `isActive`, `setActive`, `setTokenURI`, `getClosedCellsBatch`; remove XP functions
- Update `QUEST_REWARDS_ABI`: remove all escrow/burn/release functions; add `failQuest`, `startArcade`, `confirmSurvival`, `confirmDeath`
- Contract addresses will change on redeploy

### Step 6.2 — js/quest-globals.js
- Mirror all ABI changes from config.js (this file exists for generated quest pages that can't use ES modules)

### Step 6.3 — mint.html
- `PRICE` 0.02 → 2
- `MAX_SUPPLY` 70 → 10,000
- `MAX_MINT_PER_WALLET` → match new contract value
- Update UI copy for battle royale theme

### Step 6.4 — enter.html
- Show elimination status per Chad (greyed out / "ELIMINATED" badge if `eliminated(tokenId)`)
- Show locked cells count and survival ranking position
- Disable quest/gamble buttons for eliminated Chads

### Step 6.5 — stats.html
- Remove XP/experience bar display
- Level display stays (derived from closed cells)
- Add cell locking UI: slider for "how many open cells to lock" (strategic one-way decision)
- Show "Survival Rank: #X / Y alive" based on locked cells

**Depends on:** Phases 1-3 (need final ABIs)

---

## Phase 7: Frontend — Quest Flow Changes (Depends on Phase 6)

### Step 7.1 — github-api.js (quest template generator)
- Remove NFT approval step (`approve(QUEST_REWARDS_ADDRESS, tokenId)` before quest start)
- Remove "your NFT is locked in escrow" warnings/UI
- Update `startQuest` call — no longer needs prior approval
- Quest completion awards cells, not XP — update reward display
- Add arcade minigame embed point (section type for embedding arcade game)

### Step 7.2 — quest-builder.html
- Add arcade section type option (alongside single/double/dice)
- Arcade sections embed a minigame iframe and route to death/survival sections based on result

**Depends on:** Phase 6

---

## Phase 8: Frontend — New Arcade Pages (Depends on Phase 6)

### Step 8.1 — Arcade Game Framework
Create shared `js/arcade.js` with:
- `startArcadeSession(tokenId, gameType)` → calls Worker `/arcade/start` → gets session ID + seed
- `sendHeartbeat(sessionId, gameState)` → calls Worker `/arcade/heartbeat` every 10-15s
- `reportResult(sessionId, outcome)` → calls Worker `/arcade/result` → server validates → confirms on-chain

### Step 8.2 — Endless Runner (`arcade/runner.html`)
- 2D side-scrolling survival game
- Obstacles generated deterministically from server seed
- Survive 2 minutes = pass
- Collision = death → server validates → `confirmDeath()` on-chain

### Step 8.3 — Top-Down Shooter (`arcade/topshooter.html`)
- Top-down arena survival
- Enemy waves from server seed
- 2-minute survival target

### Step 8.4 — Area 51 (`arcade/area51.html`)
- Theme TBD (alien invasion? stealth?)
- Same 2-minute survival framework

### Step 8.5 — Leaderboard (`leaderboard.html`)
- Rankings by locked cells
- Alive vs eliminated count
- Monthly survival stats
- Reads from KV cache or on-chain `getClosedCellsBatch`

### Step 8.6 — Admin Culling Dashboard (add to `admin.html`)
- View all Chads ranked by locked cells
- Set elimination threshold (bottom N%)
- Trigger `batchEliminate()` for bottom Chads
- View death rate / recent eliminations

**Depends on:** Phase 6 (config/ABIs), Phase 9 (Worker endpoints)

---

## Phase 9: Backend — Cloudflare Workers (Can start in parallel with Phase 4+)

### Step 9.1 — Project Setup
- `worker/` directory with `wrangler.toml`
- D1 database bindings
- KV namespace bindings
- Environment variables: `ORACLE_PRIVATE_KEY`, `LASTCHAD_RPC`, contract addresses

### Step 9.2 — D1 Schema
```sql
CREATE TABLE arcade_sessions (
  session_id TEXT PRIMARY KEY,
  token_id INTEGER,
  player TEXT,
  game_type INTEGER,
  seed TEXT,
  start_time INTEGER,
  status TEXT DEFAULT 'active',  -- active, survived, died, expired
  heartbeat_count INTEGER DEFAULT 0,
  last_heartbeat INTEGER
);

CREATE TABLE heartbeat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  timestamp INTEGER,
  game_state TEXT,  -- JSON: position, score, obstacles hit, etc.
  FOREIGN KEY (session_id) REFERENCES arcade_sessions(session_id)
);

CREATE TABLE death_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id INTEGER,
  session_id TEXT,
  game_type INTEGER,
  timestamp INTEGER,
  validated BOOLEAN DEFAULT FALSE
);
```

### Step 9.3 — Arcade Anti-Cheat Endpoints
**`POST /arcade/start`** `{ tokenId, player }`
1. Verify `ownerOf(tokenId) == player` on-chain
2. Verify `!eliminated(tokenId)` on-chain
3. Generate seed with `crypto.getRandomValues()`
4. Store session in D1
5. Call `QuestRewards.startArcade(tokenId, gameType, seed)` on-chain
6. Return `{ sessionId, seed, expiresAt }`

**`POST /arcade/heartbeat`** `{ sessionId, timestamp, gameState }`
1. Load session from D1
2. Verify session is active and not expired
3. Verify heartbeat interval is reasonable (8-20s since last)
4. Verify game state references seed-generated patterns
5. Store in heartbeat_logs
6. Return `{ ok: true }`

**`POST /arcade/result`** `{ sessionId, outcome: "survived"|"died" }`
1. Load session + all heartbeats from D1
2. Validate: ≥2 min elapsed since start? ≥8 heartbeats? Intervals reasonable?
3. If validation fails → **outcome = survived** (fail-safe)
4. If survived: call `QuestRewards.confirmSurvival(tokenId)` on-chain
5. If died: call `QuestRewards.confirmDeath(tokenId)` on-chain
6. Update session status in D1
7. Return `{ ok: true, outcome, validated: true }`

### Step 9.4 — Quest Validation Endpoint
**`POST /quest/complete`** `{ tokenId, questId, cellReward, choices, diceResult }`
1. Verify quest session exists on-chain
2. Validate cellReward matches expected formula: `choiceBonus1 + cargoScore + choiceBonus2 + dexBonus`
3. Sign `keccak256(tokenId, questId, cellReward)` with oracle key
4. Return `{ signature }` — player submits to `completeQuest()` on-chain

### Step 9.5 — Dynamic Metadata Server
**`GET /metadata/:tokenId`**
1. Check KV for `metadata:{tokenId}` (cached response)
2. If not cached: read on-chain stats, generate JSON with current art
3. During game: serve dynamic stats + game art
4. Post-game: serve "Thanks for Playing" or survivor art (set via `setTokenURI`)
5. Cache in KV with 5-min TTL

### Step 9.6 — KV Cache Layer
- `alive:{tokenId}` → `true`/`false` — fast elimination check without RPC
- `cells:{tokenId}` → `{ open, closed }` — cached balance for leaderboard
- `leaderboard` → sorted list of tokenId:closedCells — rebuilt every 15 min
- Updated by Worker on quest completion, cell locking events, death events

**Depends on:** Phase 1-3 (contract ABIs), but can develop in parallel with tests/frontend

---

## Phase 10: Deployment & Go-Live (Depends on ALL previous phases)

### Step 10.1 — Testnet Deploy (Fuji)
1. Deploy updated LastChad.sol
2. Deploy updated QuestRewards.sol
3. Redeploy Gamble.sol (if isActive checks added)
4. Run authorization chain: `setGameContract()` on LastChad + LastChadItems
5. Set oracle addresses
6. Deploy Cloudflare Worker
7. Update all config.js addresses

### Step 10.2 — End-to-End Testing on Fuji
- Mint 10+ test NFTs
- Complete quest flow (no escrow)
- Survive arcade minigame
- Die in arcade minigame → verify elimination
- Lock cells → verify level up
- Gamble cells → verify spend/award
- Run culling → verify batchEliminate
- Verify dynamic metadata

### Step 10.3 — Mainnet Deploy
- Same steps as 10.1 but on Avalanche mainnet
- Verify all addresses in production config
- Test with small mint before public launch

---

## Dependency Graph

```
Phase 1 (LastChad.sol)
  ├── Phase 2 (QuestRewards.sol)
  │     ├── Phase 4 (Tests)
  │     ├── Phase 5 (Deploy Scripts)
  │     └── Phase 7 (Quest Flow Frontend)
  ├── Phase 3 (Gamble.sol)
  │     └── Phase 4 (Tests)
  ├── Phase 6 (Frontend Config)
  │     ├── Phase 7 (Quest Flow Frontend)
  │     └── Phase 8 (Arcade Pages)
  └── Phase 9 (Workers) ← can start in parallel after Phase 1-3 ABIs are known
        └── Phase 8 (Arcade Pages — needs Worker endpoints)

Phase 10 (Deploy) ← after everything
```

## Open Questions for User

1. **MAX_MINT_PER_WALLET** — keep at 5? Increase? Remove limit entirely?
2. **Quest cooldown** — 30 days between same quest? Or per-month reset?
3. **Can players gamble while in a quest/arcade session?** (isActive check on Gamble)
4. **game.html dice game** — becomes an arcade minigame? Stays separate? Gets removed?
5. **Arcade game art/assets** — who builds the actual minigame gameplay? (sprites, physics, levels)
6. **Culling trigger** — manual (owner calls batchEliminate) or automated (Worker cron)?
7. **Endgame threshold** — fixed at 1,000 survivors or configurable?
