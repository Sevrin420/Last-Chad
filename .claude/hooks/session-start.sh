#!/bin/bash
set -euo pipefail

echo '{"async": false}'

# Display project overview
cat << 'OVERVIEW'

╔════════════════════════════════════════════════════════════════╗
║                   🎮 LAST CHAD - Session Start 🎮             ║
╚════════════════════════════════════════════════════════════════╝

📖 PROJECT OVERVIEW
   Last Chad is a text-based adventure RPG with upgradable NFTs
   - Play-to-earn gameplay with NFT characters
   - Quest system for narrative progression
   - Smart contract-based asset management

⚙️  TECH STACK
   - Hardhat (Ethereum development framework)
   - Solidity smart contracts
   - OpenZeppelin contracts for NFT standards
   - Hardhat testing framework

📋 PRIMARY FOCUS
   ✨ Creating new quests and adventures
   - Quest design and implementation
   - NPC interactions and dialogue
   - Reward systems and progression logic

📁 KEY DIRECTORIES
   - /contracts  → Solidity smart contracts
   - /test      → Hardhat tests
   - /scripts   → Deployment scripts
   - /*.html    → Game UI interface
   - /metadata  → NFT metadata

🔧 COMMON COMMANDS
   - npm test          → Run test suite
   - npm run hardhat   → Hardhat CLI
   - npm run compile   → Compile contracts

════════════════════════════════════════════════════════════════

OVERVIEW

# Install dependencies
npm install
