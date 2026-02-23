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

### Adding a New Quest
1. Increment `QUEST_COUNT` in `QuestRewards.sol`
2. Define choice bonuses (typically 1–3 range)
3. Define dex scaling
4. Test dice derivation with `keccak256(seed, roll, die)`
5. Validate XP formula

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
