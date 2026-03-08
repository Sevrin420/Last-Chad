// One-time script: award 5 starter cells to all currently minted Chads (tokens 1-6)
// Run: npx hardhat run scripts/awardStarterCells.js --network fuji

const hre = require("hardhat");
const { LAST_CHAD: CONTRACT_ADDRESS } = require('./addresses');
const CELLS_TO_AWARD   = 5;
const TOKEN_IDS        = [1, 2, 3, 4, 5, 6];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  console.log("Awarding cells from:", owner.address);

  const lastChad = await hre.ethers.getContractAt("LastChad", CONTRACT_ADDRESS, owner);

  for (const tokenId of TOKEN_IDS) {
    try {
      const current = await lastChad.getCells(tokenId);
      console.log(`Token #${tokenId} — current cells: ${current}`);

      const tx = await lastChad.awardCells(tokenId, CELLS_TO_AWARD);
      await tx.wait();

      const updated = await lastChad.getCells(tokenId);
      console.log(`Token #${tokenId} — cells after award: ${updated} ✓`);
    } catch (err) {
      console.error(`Token #${tokenId} failed:`, err.message);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
