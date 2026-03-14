# CLAUDE.md — Last Chad

## Working Rules (Read First)

- NEVER try to understand or reference the entire codebase at once. Only consider files explicitly mentioned or provided.
- Work in EXTREMELY SMALL, ATOMIC steps: one file, one function, one bug fix, one small feature addition per response.
- If a change affects multiple files, propose them one at a time and wait for approval before the next.
- Do NOT rewrite large sections or refactor unrelated code unless specifically asked.
- Output ONLY the changed code sections with clear file paths and minimal explanation unless asked for more.
- If something is unclear or needs more context, ask ONE precise question instead of guessing or stalling.
- Keep responses short and focused — aim for under 1000 tokens total output.
- If the task seems too broad, say "This task is too broad — please narrow it to one specific change" and stop.

### Off-Limits Files (Do NOT touch unless explicitly told to)
- **`quest.html`** — IGNORE entirely unless the user specifically says to edit it.
- **`quests/*/index.html`** (individual quest files) — NEVER modify. Quests are generated output from `github-api.js` + `quest-builder.html`. All quest template changes go in `github-api.js` only.

### Implementation Plans
- **`gamble.md`** — Poker (video poker / Jacks or Better) implementation plan. Read this before implementing any gambling/poker features. Covers Gamble.sol additions, Cloudflare Worker endpoints, frontend changes, and deploy steps.

---

## Project Overview

**Last Chad** is a text-based adventure RPG with upgradable NFTs on Avalanche.

- Play-to-earn gameplay with ERC-721 character NFTs
- Deterministic quest system with dice-based mechanics
- ERC-1155 item system with stackable/non-stackable items
- Web3 wallet integration for blockchain gameplay
- GitHub Pages hosted at lastchad.xyz

---

## Tech Stack

- **Hardhat** v2.28.5 — Ethereum/Avalanche development framework
- **Solidity** v0.8.26 — 3 smart contracts
- **OpenZeppelin** v5.0.0 — ERC721, ERC1155, Ownable
- **Web3.js + WalletConnect** — frontend integration
- **Compiler optimizer**: 200 runs

---

## Project Architecture

### Smart Contracts (`/`)

| File | Lines | Purpose |
|------|-------|---------|
| `LastChad.sol` | 166 | ERC-721 NFT character cards |
| `LastChadItems.sol` | 208 | ERC-1155 multi-token item system |
| `QuestRewards.sol` | 259 | Quest system with deterministic rewards |

**LastChad.sol**
- 70 NFT max supply, 0.02 AVAX per mint, max 5 per wallet
- Stats: Strength, Intelligence, Dexterity, Charisma (2 points on mint)
- Experience & leveling (100 XP per level), stat point spending on level-up

**LastChadItems.sol**
- Dynamic item creation (no redeployment needed)
- Stackable vs non-stackable items
- Item #1: "Cindy's Code" (500 supply, free, non-stackable)

**QuestRewards.sol**
- `startQuest()` → generates keccak256 seed
- `completeQuest()` → dice rolls, XP calculation, awards via LastChad
- 1-hour session timeout, 1 attempt per quest per token
- XP = choiceBonus1 + diceScore + choiceBonus2 + dexBonus

### Tests (`/test`)

| File | Size | Covers |
|------|------|--------|
| `LastChad.test.js` | 18KB | Deployment, minting, stats, experience, game auth |
| `QuestRewards.test.js` | 15KB | startQuest, completeQuest, dice derivation |

### Scripts (`/scripts`)

- `deployItems.js` — Deploys LastChadItems, seeds Cindy's Code

### Frontend (`/`)

| File | Lines | Purpose |
|------|-------|---------|
| `index.html` | 320 | Landing page (MINT / ENTER buttons) |
| `mint.html` | 1264 | NFT minting: wallet, quantity, stats, naming |
| `enter.html` | 1036 | Character selection & inventory |
| `game.html` | 701 | Dice rolling minigame |
| `quest-builder.html` | — | Quest creation tool |
| `stats.html` | 1417 | Character progression & stat spending |
| `docs.html` | 1114 | Game rules & documentation |
| `admin.html` | 470 | Owner control panel |
| `deploy.html` | 303 | Deployment status & contract addresses |

### Utilities (`/`)

| File | Purpose |
|------|---------|
| `hardhat.config.js` | Networks: Avalanche mainnet + Fuji testnet |
| `nav.js` | Dynamic navigation menu injection (44 lines) |
| `nav.css` | Responsive hamburger menu styles |
| `styles.css` | Global styles: Press Start 2P font, gold/bronze theme |
| `compile.js` | Standalone solc compiler for LastChad.sol |

### Assets

- `/chads/` — Character artwork: 1.png–20.png + Picsart variants
- `/docs_lobby/` — Lobby/item imagery (8 JPG files)
- `/metadata/[1-6]/` — ERC-721 metadata JSON (served at lastchad.xyz/metadata/)
- `/items/1/` — Cindy's Code item metadata

---

## Quest System Mechanics

### Dice Scoring Rules
- Must roll: **6** (SHIP) + **5** (CAPTAIN) + **4** (MATE)
- If all three present: XP = sum of remaining 2 dice (2–12)
- If any missing: XP = 0
- Deterministic: same seed + same kept dice = same score

### XP Formula
```
XP = choiceBonus1 + diceScore + choiceBonus2 + dexBonus
```
- Choice bonuses: choice1 (1 or 3) + choice2 (2 or 3)
- dexBonus: 1 dex point ≈ 1 XP bonus

### On-Chain Dice — Mandatory
Dice rolls in quest gameplay always derive from an on-chain keccak256 seed. There is no `Math.random()` fallback in quest pages.

- Roll button shows **"AWAITING SEED"** (disabled) until `startQuest()` confirms on-chain and sets `_questSeed`
- Once the seed arrives the button re-enables as **"ROLL"** and all dice are deterministic
- **Exception**: `docs.html` Celo Tech demo uses `Math.random()` for its local illustration only

#### Deploying Quest Rewards (Required Before Quests Work)
1. Deploy: `npx hardhat run scripts/deployQuestRewards.js --network fuji`
2. Copy the address into `QUEST_REWARDS_ADDRESS` in `js/config.js` and each quest's HTML
3. Authorize: call `lastChad.setGameContract(questRewardsAddress, true)` from the owner wallet

### Adding a New Quest
1. Increment `QUEST_COUNT` in `QuestRewards.sol`
2. Define choice bonuses (typically 1–3 range)
3. Define dex scaling
4. Test dice derivation with `keccak256(seed, roll, die)`
5. Validate XP formula

### Quest Builder Architecture (How It All Fits Together)

The quest system has two distinct layers — the **builder** and the **generated output**:

```
quest-builder.html          ← UI for creating quests (drag sections, upload images, set choices)
      │
      ▼
github-api.js               ← generateQuestHTML() turns quest data into a complete HTML file
      │                        Also handles GitHub API calls to commit the file + images
      ▼
quests/{slug}/index.html    ← GENERATED OUTPUT. Never edit manually. Regenerate via builder.
quests/{slug}/data.json     ← Raw quest data (sections, choices, music, item awards)
quests/{slug}/images/       ← Section images uploaded through the builder
quests/index.json           ← Registry of all quests (name + slug + optional questId)
```

**Key files to edit for quest template changes:**
- `github-api.js` — All HTML/CSS/JS that goes into generated quests lives here
- `quest-builder.html` — The builder UI itself (section editor, preview, publish button)

**Key variables in `github-api.js` (generated script scope):**
- `knownItems` — `{ id: "Name" }` map used for item names in HUD badges and awards
- `HUD_ITEM_DETAILS` — `{ id: { image: url } }` for item badge images in the quest HUD
- `ITEM_MODIFIERS` — `{ id: { str, int, dex, cha } }` for stat bonuses from equipped items
- `loadQuestHUD(sid)` — Populates the portrait + stats + items HUD above dice sections
- `showPanel(id)` — Switches the active section panel; calls `loadQuestHUD` if panel has `.quest-hud`
- `animatePanel(sid)` — Fades in section image → types narrative → reveals action buttons

**Quest section types (selectedChoice field):**
- `'single'` — One button, goes to a fixed next section
- `'double'` — Two choice buttons, each routes to a different section
- `'dice'` — Dice game; no section image (HUD replaces it); pass/fail route to different sections

### Adding a New Item Award Option (Quest Builder)
To make a new ERC-1155 item available as a section reward in the quest builder:
1. Add an `<option>` to the `section-item-award-select` dropdown in `quest-builder.html`:
   ```html
   <option value="2" ${section.itemAward === '2' ? 'selected' : ''}>2: Item Name</option>
   ```
2. Add a matching entry to the `knownItems` map in `github-api.js` (`generateQuestHTML`):
   ```js
   const knownItems = { '1': "Cindy's Code", '2': "Item Name" };
   ```
The item ID must match its ID in `LastChadItems.sol`. The `mint(itemId, 1)` call uses the price returned by `getItem()` on-chain, so free items (price=0) cost only gas.

### Adding a New Item to the Equip System (quest.html / HUD)
When a new ERC-1155 item is created, register it in two places so it appears in the equip modal and applies stat bonuses in the quest HUD:
1. Add to `KNOWN_ITEMS` in `quest.html`:
   ```js
   const KNOWN_ITEMS = { '1': "Cindy's Code", '2': "Item Name" };
   ```
2. Add to `ITEM_MODIFIERS` in `github-api.js`:
   ```js
   const ITEM_MODIFIERS = { '1': { str:0, int:1, dex:0, cha:0 }, '2': { str:1, int:0, dex:0, cha:0 } };
   ```
The item ID must match its ID in `LastChadItems.sol`. Equipped items are saved per-chad in `localStorage` as `lc_equipped_{tokenId}` (array of 4 item ID strings or nulls).

---

## Full Game Flow & Contract Logic

### Player Lifecycle (end-to-end)

```
1. MINT        mint.html        → LastChad.mint()         → ERC-721 token #1–70
2. SETUP       mint.html        → LastChad.setStats()     → name + 2 stat points distributed
3. QUEST       quests/*/        → QuestRewards.startQuest() → NFT locked in escrow
4. GAMEPLAY    off-chain (JS)   → dice rolls derived from seed, narrative choices made
5. RESOLVE     game server      → QuestRewards.completeQuest() → NFT returned + XP awarded
6. LEVEL UP    stats.html       → LastChad.spendStatPoint()  → player assigns new stat point
```

---

### Contract Roles

| Contract | Role |
|----------|------|
| `LastChad.sol` | Source of truth for ownership, stats, XP, levels, cells |
| `LastChadItems.sol` | ERC-1155 item registry; minting gated by authorized game contracts |
| `QuestRewards.sol` | Quest escrow + reward dispatcher; the only authorized game contract |

**Authorization chain:**
- `LastChad.setGameContract(questRewardsAddress, true)` → allows `QuestRewards` to call `awardExperience`, `awardCells`, `spendCells`
- `LastChadItems.setGameContract(questRewardsAddress, true)` → allows `QuestRewards` to call `mintTo`
- Both authorizations must be set by the owner wallet after deploy

---

### NFT Character (LastChad.sol)

**Minting:**
- Max supply: 70 NFTs, 0.02 AVAX each, max 5 per wallet
- `mint(quantity)` — sequential token IDs starting at 1

**One-time setup (setStats):**
- Player distributes exactly 2 stat points across STR / INT / DEX / CHA
- Sets the character name (1–12 chars)
- `assigned` flag permanently prevents re-calling `setStats`

**Stats (4 attributes, all uint32):**
- `strength`, `intelligence`, `dexterity`, `charisma`
- Base 0 + 2 points from setup + 1 point per level-up thereafter
- `spendStatPoint(tokenId, statIndex)` — player chooses which stat to raise

**Experience & Leveling:**
- XP accumulates in `_tokenExperience[tokenId]`
- Level = `(totalXP / 100) + 1` — so level 1 = 0–99 XP, level 2 = 100–199 XP, etc.
- On level-up: `_pendingStatPoints[tokenId]++` for each level gained
- Only `onlyGameOrOwner` can award XP (QuestRewards or contract owner)

**Cells (in-quest currency):**
- `_tokenCells[tokenId]` — persistent across quests, tied to the NFT not the wallet
- Awarded mid-quest by game owner via `awardCells(tokenId, amount)`
- Spent by player in quest shop via `QuestRewards.purchaseItem()` → calls `LastChad.spendCells()`
- Only `onlyGameOrOwner` can award or spend cells

---

### Item System (LastChadItems.sol)

**Item definition (ItemDef struct):**
- `name`, `maxSupply` (0 = unlimited), `minted`, `price` (AVAX wei, 0 = free), `stackable`, `active`
- Item IDs start at 1; `nextItemId` increments on each `createItem`
- Item #1 "Cindy's Code": supply 500, free, non-stackable

**Minting paths:**
| Path | Function | Who | Price enforced |
|------|----------|-----|----------------|
| Direct claim | `mint(itemId, qty)` | Player (AVAX) | Yes — AVAX price from ItemDef |
| Quest reward | `mintTo(to, itemId, 1)` | QuestRewards | No — game handles cell cost |
| Airdrop | `airdrop(to, itemId, qty)` | Owner only | No |

**Non-stackable rule:** `balanceOf(to, itemId) == 0` enforced inside `_mintItem` — one per wallet, ever.

**Stat effects:** Resolved entirely client-side via `ITEM_MODIFIERS` in `github-api.js`. Not stored on-chain.

---

### Quest Flow (QuestRewards.sol)

#### 1. startQuest (player)
```
Player calls startQuest(tokenId, questId)
  → Requires: ownerOf(tokenId) == msg.sender
  → Requires: !questStarted[tokenId][questId]   ← one attempt per quest per token, ever
  → Sets:     questStarted[tokenId][questId] = true
  → Sets:     lockedBy[tokenId] = msg.sender
  → Transfers: NFT from player → QuestRewards (escrow)
  → Generates: seed = keccak256(tokenId, questId, block.prevrandao, block.timestamp, msg.sender)
  → Stores:   QuestSession { seed, questId, startTime, active:true }
  → Emits:    QuestStarted(tokenId, questId, seed, expiresAt)
```

#### 2. Mid-quest awards (game owner, any order, any number of times)
```
awardCells(tokenId, amount)   → LastChad.awardCells()   → player gains cells
awardItem(tokenId, itemId)    → LastChadItems.mintTo()  → player gains ERC-1155 item
```
Both require `lockedBy[tokenId] != address(0)` (NFT must still be locked).

#### 3. purchaseItem (player, during active session only)
```
Player calls purchaseItem(tokenId, itemId)
  → Requires: lockedBy[tokenId] == msg.sender        ← must be the quest participant
  → Requires: session.active == true
  → Requires: block.timestamp <= startTime + 1 hour  ← enforced explicitly
  → Requires: itemPrices[itemId] > 0                 ← item must be in the quest shop
  → Calls:    LastChad.spendCells(tokenId, cost)
  → Calls:    LastChadItems.mintTo(msg.sender, itemId, 1)
```

#### 4a. completeQuest — success (game owner)
```
completeQuest(tokenId, questId, xpAmount > 0)
  → Requires: session.active, correct questId, not expired, not already completed
  → Deletes:  pendingSessions[tokenId]
  → Sets:     questCompleted[tokenId][questId] = true
  → Deletes:  lockedBy[tokenId]
  → Transfers: NFT from QuestRewards → original player
  → Calls:    LastChad.awardExperience(tokenId, xpAmount)
  → Emits:    QuestCompleted
```

#### 4b. completeQuest — fail (game owner)
```
completeQuest(tokenId, questId, xpAmount == 0)
  → Deletes:  pendingSessions[tokenId]   ← session gone, but lockedBy remains
  → NFT stays locked in escrow
  → Emits:    QuestFailed
  → Next step: burnLocked (permanent) or releaseLocked (mercy)
```

#### 5. burnLocked (game owner — fail outcome)
```
burnLocked(tokenId)
  → Deletes:  lockedBy[tokenId]
  → Transfers: NFT → 0x000...dEaD (burned forever)
  → Emits:    NFTBurned
```

#### 6. releaseLocked (game owner — error recovery / mercy)
```
releaseLocked(tokenId)
  → Deletes:  lockedBy[tokenId] + pendingSessions[tokenId]
  → Transfers: NFT back to original owner
  → Emits:    NFTReleased
```

---

### Session Constraints

| Rule | Where enforced |
|------|----------------|
| 1-hour session window | `completeQuest` and `purchaseItem` both check `block.timestamp <= startTime + 1 hour` |
| One attempt per quest per token | `questStarted[tokenId][questId]` set before NFT transfer, never cleared |
| One quest at a time | NFT is in escrow; player can't start another quest with the same token |
| Shop only while locked | `purchaseItem` requires `lockedBy[tokenId] == msg.sender` |

---

### Seed & Dice Derivation

**Seed generation (on-chain, in startQuest):**
```solidity
seed = keccak256(abi.encodePacked(tokenId, questId, block.prevrandao, block.timestamp, msg.sender))
```

**Dice rolls (off-chain, deterministic from seed):**
- Each die roll: `keccak256(seed, rollIndex, dieIndex)` → value 1–6
- Roll button stays disabled ("AWAITING SEED") until `startQuest` tx confirms and seed is retrieved
- No `Math.random()` in quest pages — every number must trace back to the on-chain seed

**Ship Captain Crew scoring:**
- Must have: 6 (SHIP) + 5 (CAPTAIN) + 4 (MATE) among kept dice
- If all three present: cargo score = sum of remaining 2 dice (range 2–12)
- If any missing: cargo score = 0
- Same seed + same kept dice = same score always (fully deterministic)

**XP formula:**
```
xpAmount = choiceBonus1 + cargoScore + choiceBonus2 + dexBonus
```
- `choiceBonus1`: story choice at start (e.g. 1 or 3 XP)
- `cargoScore`: 0–12 from dice
- `choiceBonus2`: story choice at end (e.g. 2 or 3 XP)
- `dexBonus`: character's dexterity stat (1 DEX ≈ 1 XP)

---

### gameOwner Trust Model

`gameOwner` is set to `msg.sender` at deploy time and is `immutable` — it cannot be changed.

**Powers of gameOwner:**
- Call `completeQuest`, `awardCells`, `awardItem`, `burnLocked`, `releaseLocked`
- Set shop item prices via `setItemPrice`
- Award unlimited XP/cells to any locked token (no cap on-chain)
- Burn any locked NFT permanently

**Implication:** The game owner wallet must be secured (hardware wallet recommended). If lost, any currently locked NFTs are permanently stuck.

---

## Common Commands

```bash
# Testing
npm test                              # Full test suite
npx hardhat test --grep "keyword"     # Specific tests

# Compilation
npx hardhat compile                   # Compile contracts
node compile.js                       # Standalone compilation

# Deployment
npx hardhat run scripts/deployItems.js --network fuji   # Testnet deploy

# Setup
npm install                           # Install dependencies
```

---

## Networks

| Network | Purpose |
|---------|---------|
| Avalanche Mainnet | Production |
| Fuji Testnet | Testing & deployment staging |

---

## Future Contract Notes (5555-token LastChad.sol)

The current `LastChad.sol` extends plain `ERC721` (no `ERC721Enumerable`), so `tokenOfOwnerByIndex` is not available. The market's `populateSellTokens()` works around this with a `balanceOf` + `totalSupply` loop (max 70 calls on the test contract).

**When deploying the 5555-token production contract**, add `ERC721Enumerable`:
1. Change `ERC721` → `ERC721Enumerable` in the `is` clause
2. Add the required override: `function supportsInterface(bytes4 id) public view override(ERC721Enumerable) returns (bool) { return super.supportsInterface(id); }`
3. Update `market.html` `ERC721_ABI`: swap `totalSupply()` back to `tokenOfOwnerByIndex(address, uint256)` and rewrite `populateSellTokens()` to use `balanceOf` + `tokenOfOwnerByIndex` loop — O(owned) not O(totalSupply).
