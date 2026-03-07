/**
 * releaseEscrow.js
 *
 * Reads all NFT token IDs currently locked in QuestRewards escrow,
 * then calls batchReleaseLocked() to return them to their original owners.
 *
 * Usage (local):
 *   npx hardhat run scripts/releaseEscrow.js --network fuji
 *
 * Usage (CI):
 *   Triggered via GitHub Actions → Deploy → target: release-escrow
 *
 * Required env vars:
 *   PRIVATE_KEY  — game owner / deployer wallet (must match gameOwner on contract)
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// Read QUEST_REWARDS_ADDRESS from js/config.js so this script stays in sync
const configPath = path.join(__dirname, '..', 'js', 'config.js');
const configContent = fs.readFileSync(configPath, 'utf8');
const addrMatch = configContent.match(/QUEST_REWARDS_ADDRESS\s*=\s*'([^']+)'/);
if (!addrMatch) {
  console.error("Could not find QUEST_REWARDS_ADDRESS in js/config.js");
  process.exit(1);
}
const QUEST_REWARDS_ADDRESS = addrMatch[1];

const QUEST_REWARDS_ABI = [
  'function getLockedTokenIds() view returns (uint256[])',
  'function batchReleaseLocked(uint256[] tokenIds) external',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nEscrow Release on [${network}]`);
  console.log(`Owner wallet:     ${owner.address}`);
  console.log(`QuestRewards:     ${QUEST_REWARDS_ADDRESS}\n`);

  const contract = new hre.ethers.Contract(QUEST_REWARDS_ADDRESS, QUEST_REWARDS_ABI, owner);

  // ── 1. Fetch locked token IDs ─────────────────────────────────────────────
  console.log("Fetching locked token IDs...");
  const locked = await contract.getLockedTokenIds();
  const ids = locked.map(id => (id.toNumber ? id.toNumber() : Number(id)));

  if (ids.length === 0) {
    console.log("✅  No NFTs currently in escrow. Nothing to release.");
    return;
  }

  console.log(`Found ${ids.length} locked NFT(s): [${ids.join(', ')}]`);

  // ── 2. Batch release ───────────────────────────────────────────────────────
  console.log("\nSending batchReleaseLocked()...");
  const tx = await contract.batchReleaseLocked(ids);
  console.log(`  tx: ${tx.hash}`);
  console.log("  Waiting for confirmation...");
  const receipt = await tx.wait();

  console.log(`\n✅  Released ${ids.length} NFT(s) in block ${receipt.blockNumber}`);
  console.log(`   Token IDs returned to owners: [${ids.join(', ')}]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
