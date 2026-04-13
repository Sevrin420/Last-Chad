// One-time script: award starter chips to specific Chads
// Run: npx hardhat run scripts/awardStarterCells.js --network fuji

const hre = require("hardhat");
const { MEMBERS_ONLY: CONTRACT_ADDRESS } = require('./addresses');
const CHIPS_TO_AWARD = 50;
const TOKEN_IDS      = [1, 2, 3, 4, 5, 6];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  console.log("Awarding chips from:", owner.address);

  const contract = await hre.ethers.getContractAt("MembersOnly", CONTRACT_ADDRESS, owner);

  for (const tokenId of TOKEN_IDS) {
    try {
      const current = await contract.getChips(tokenId);
      console.log(`Token #${tokenId} — current chips: ${current}`);

      const tx = await contract.awardChips(tokenId, CHIPS_TO_AWARD);
      await tx.wait();

      const updated = await contract.getChips(tokenId);
      console.log(`Token #${tokenId} — chips after award: ${updated} ✓`);
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
