// Award 100 open cells to every Chad NFT currently in the owner wallet.
// Run: npx hardhat run scripts/awardOwnerCells.js --network fuji
//      npx hardhat run scripts/awardOwnerCells.js --network avalanche

const hre = require("hardhat");
const { LAST_CHAD: CONTRACT_ADDRESS } = require('./addresses');

const CELLS_TO_AWARD = 100;

const ABI = [
  'function totalSupply() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getOpenCells(uint256 tokenId) view returns (uint256)',
  'function awardCells(uint256 tokenId, uint256 amount) external',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  console.log("Owner wallet:", owner.address);
  console.log("Contract:    ", CONTRACT_ADDRESS);
  console.log("Cells/Chad:  ", CELLS_TO_AWARD);
  console.log("─".repeat(50));

  const lastChad = new hre.ethers.Contract(CONTRACT_ADDRESS, ABI, owner);

  const totalRaw = await lastChad.totalSupply();
  const total = totalRaw.toNumber ? totalRaw.toNumber() : Number(totalRaw);
  console.log(`Total supply: ${total} Chads\n`);

  const owned = [];
  for (let id = 1; id <= total; id++) {
    try {
      const tokenOwner = await lastChad.ownerOf(id);
      if (tokenOwner.toLowerCase() === owner.address.toLowerCase()) {
        owned.push(id);
      }
    } catch (_) {}
  }

  if (owned.length === 0) {
    console.log("No Chads found in owner wallet. Nothing to do.");
    return;
  }

  console.log(`Found ${owned.length} Chad(s) in owner wallet: [${owned.join(', ')}]\n`);

  for (const tokenId of owned) {
    try {
      const before = (await lastChad.getOpenCells(tokenId)).toString();
      console.log(`Chad #${tokenId} — open cells before: ${before}`);

      const tx = await lastChad.awardCells(tokenId, CELLS_TO_AWARD);
      await tx.wait();

      const after = (await lastChad.getOpenCells(tokenId)).toString();
      console.log(`Chad #${tokenId} — open cells after:  ${after} ✓`);
    } catch (err) {
      console.error(`Chad #${tokenId} failed:`, err.message);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
