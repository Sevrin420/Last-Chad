// Award 100 open cells to EVERY minted Chad (all token IDs 1..totalSupply).
// Uses batchAwardCells for gas efficiency (single transaction).
// Run: npx hardhat run scripts/awardAllCells.js --network fuji
//      npx hardhat run scripts/awardAllCells.js --network avalanche

const hre = require("hardhat");
const { LAST_CHAD: CONTRACT_ADDRESS } = require('./addresses');

const CELLS_TO_AWARD = 100;

const ABI = [
  'function totalSupply() view returns (uint256)',
  'function batchAwardCells(uint256[] tokenIds, uint256[] amounts) external',
  'function getOpenCells(uint256 tokenId) view returns (uint256)',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  console.log("Owner wallet:", owner.address);
  console.log("Contract:    ", CONTRACT_ADDRESS);
  console.log("Cells/Chad:  ", CELLS_TO_AWARD);
  console.log("─".repeat(50));

  const lastChad = new hre.ethers.Contract(CONTRACT_ADDRESS, ABI, owner);

  const totalRaw = await lastChad.totalSupply();
  const total = Number(totalRaw);
  console.log(`Total supply: ${total} Chads\n`);

  if (total === 0) {
    console.log("No Chads minted yet. Nothing to do.");
    return;
  }

  const tokenIds = [];
  const amounts = [];
  for (let id = 1; id <= total; id++) {
    tokenIds.push(id);
    amounts.push(CELLS_TO_AWARD);
  }

  console.log(`Awarding ${CELLS_TO_AWARD} cells to tokens [${tokenIds.join(', ')}]...`);

  const tx = await lastChad.batchAwardCells(tokenIds, amounts);
  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed.toString()})`);

  // Spot-check a few
  for (const id of [tokenIds[0], tokenIds[tokenIds.length - 1]]) {
    const cells = (await lastChad.getOpenCells(id)).toString();
    console.log(`Chad #${id} — open cells: ${cells}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
