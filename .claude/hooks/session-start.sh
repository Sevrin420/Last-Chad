#!/bin/bash
set -euo pipefail

echo '{"async": false}'

# Display project overview
cat << 'OVERVIEW'

╔════════════════════════════════════════════════════════════════════════════╗
║                      🎮 LAST CHAD - Session Start 🎮                      ║
╚════════════════════════════════════════════════════════════════════════════╝

📖 PROJECT OVERVIEW
   Last Chad: Text-based adventure RPG with upgradable NFTs on Avalanche
   - Play-to-earn gameplay with ERC-721 character NFTs
   - Deterministic quest system with dice-based mechanics
   - ERC-1155 item system with stackable/non-stackable items
   - Web3 wallet integration for blockchain gameplay

⚙️  TECH STACK
   - Hardhat v2.28.5 (Ethereum/Avalanche development framework)
   - Solidity v0.8.26 (3 smart contracts)
   - OpenZeppelin v5.0.0 (ERC721, ERC1155, Ownable)
   - Web3.js + WalletConnect for frontend integration
   - GitHub Pages hosted at lastchad.xyz

🎯 PRIMARY FOCUS: CREATING NEW QUESTS
   - Design quest gameplay mechanics
   - Implement new QuestRewards quest types
   - Add narrative flavor and NPC interactions
   - Balance XP rewards and stat bonuses

═══════════════════════════════════════════════════════════════════════════════

📋 DIRECTORY STRUCTURE & FILES

📁 /SMART CONTRACTS
   ├─ LastChad.sol (166 lines)
   │  └─ ERC-721 NFT contract for character cards
   │     • 70 NFT max supply, 0.02 AVAX per mint, max 5 per wallet
   │     • Stat system: Strength, Intelligence, Dexterity, Charisma (2 points)
   │     • Experience & leveling (1 level per 100 XP)
   │     • Stat point spending on level-up
   │
   ├─ LastChadItems.sol (208 lines)
   │  └─ ERC-1155 multi-token contract for items
   │     • Dynamic item creation (no redeployment)
   │     • Stackable vs non-stackable items
   │     • Item #1: "Cindy's Code" (500 supply, free, non-stackable)
   │
   └─ QuestRewards.sol (259 lines)
      └─ Quest system with deterministic rewards
         • startQuest() → generates keccak256 seed
         • completeQuest() → dice rolls, XP calculation, awards via LastChad
         • 1-hour session timeout, 1 attempt per quest per token
         • Dice scoring: Need 6+5+4, XP = choice bonuses + dice + dex bonus

📁 /test
   ├─ LastChad.test.js (18KB)
   │  └─ Tests: deployment, minting, stats, experience, game auth
   │
   └─ QuestRewards.test.js (15KB)
      └─ Tests: startQuest, completeQuest, dice derivation

📁 /scripts
   └─ deployItems.js → Deploys LastChadItems, seeds Cindy's Code

📁 /FRONTEND - INTERACTIVE HTML PAGES
   ├─ index.html (320 lines)
   │  └─ Landing page with MINT / ENTER buttons
   │
   ├─ mint.html (1,264 lines) ⭐ ACTIVE DEVELOPMENT
   │  └─ NFT minting interface
   │     • Wallet connection, quantity selection
   │     • Stats allocation: 2 points across 4 attributes
   │     • Character naming (1-12 chars)
   │     • Real-time mint count display
   │
   ├─ enter.html (1,036 lines)
   │  └─ Character selection & inventory
   │     • Gallery of owned NFTs with stats
   │     • Links to: game.html, quest.html, stats.html
   │     • Claim Items interface
   │
   ├─ game.html (701 lines)
   │  └─ Dice rolling minigame
   │     • 5 dice with 1-6 pips display
   │     • 3 rolls per turn, LOCK buttons
   │     • Checklist for required dice (6, 5, 4)
   │     • Score display (sum of remaining dice)
   │
   ├─ quest.html (1,458 lines) ⭐ XP REWARDS HERE
   │  └─ Quest completion interface
   │     • Active quest sessions with 1-hour timer
   │     • XP reward calculation display
   │     • Integration with QuestRewards contract
   │     • Choice bonuses: choice1 (1 or 3) + choice2 (2 or 3)
   │
   ├─ stats.html (1,417 lines)
   │  └─ Character progression viewer
   │     • Level, experience, all 4 stats with bars
   │     • Spend stat points interface
   │     • Experience curve visualization
   │
   ├─ docs.html (1,114 lines)
   │  └─ Game rules & documentation
   │     • Quest mechanics explained
   │     • Dice scoring rules
   │     • Stat effects & item system
   │
   ├─ admin.html (470 lines)
   │  └─ Owner control panel
   │     • Contract management, BaseURI updates
   │     • Mint/airdrop functions
   │
   └─ deploy.html (303 lines)
      └─ Deployment status & contract addresses

📁 /CONFIGURATION & UTILITIES
   ├─ hardhat.config.js
   │  └─ Compiler: v0.8.26 (optimizer: 200 runs)
   │     Networks: Avalanche mainnet + Fuji testnet
   │
   ├─ package.json
   │  └─ Dependencies: hardhat, @openzeppelin/contracts, solc
   │
   ├─ compile.js
   │  └─ Standalone solc compiler for LastChad.sol
   │
   ├─ nav.js (44 lines)
   │  └─ Dynamic navigation menu injection
   │
   ├─ nav.css
   │  └─ Responsive hamburger menu styles
   │
   └─ styles.css
      └─ Global styles: Press Start 2P font, gold/bronze theme
         Dark backgrounds, 3D button effects, responsive clamp()

📁 /ASSETS
   ├─ /chads/ (40+ PNG files)
   │  └─ Character artwork: 1.png - 20.png (base) + Picsart variants
   │
   ├─ /docs_lobby/ (8 JPG files)
   │  └─ Lobby/item imagery: angry, sad, thrilled, wave, brochure moods
   │
   └─ Background images & promotional artwork

📁 /metadata (NFT METADATA)
   ├─ /1, /2, /3, /4, /5, /6/
   │  └─ Each contains index.html with ERC-721 metadata JSON
   │     Format: name, description, image, attributes
   │
   └─ Served at: https://lastchad.xyz/metadata/[1-6]/

📁 /items (ITEM METADATA)
   └─ /1/ → Cindy's Code item metadata
      └─ Served at: https://lastchad.xyz/items/1

═══════════════════════════════════════════════════════════════════════════════

🔧 COMMON COMMANDS

Testing & Compilation:
   npm test                     → Run full test suite
   npx hardhat test --grep "x"  → Run specific tests
   npx hardhat compile          → Compile Solidity contracts
   node compile.js              → Standalone compilation

Blockchain Interaction:
   npx hardhat run scripts/deployItems.js --network fuji   → Deploy to testnet

Local Development:
   npm install                  → Install dependencies
   npm audit                    → Check for vulnerabilities

═══════════════════════════════════════════════════════════════════════════════

🚀 QUEST SYSTEM MECHANICS

When Creating New Quests:
1. Add new quest type to QuestRewards.QUEST_COUNT
2. Define choice bonuses (typically 1-3 range)
3. Define dex scaling (1 dex point = ~1 XP bonus)
4. Test dice derivation with keccak256(seed, roll, die)
5. Validate XP = choiceBonus1 + diceScore + choiceBonus2 + dexBonus

Dice Scoring Rules:
   • Must roll: 6 (SHIP) + 5 (CAPTAIN) + 4 (MATE)
   • If all present: XP = sum of remaining 2 dice (2-12)
   • If any missing: XP = 0
   • Deterministic: Same seed + same kept dice = same score

═══════════════════════════════════════════════════════════════════════════════

OVERVIEW

# Install dependencies
npm install
