// Award chips to EVERY minted Chad (all token IDs 1..totalMinted).
// Uses batchAwardChips for gas efficiency (single transaction).
// Run: npx hardhat run scripts/awardAllCells.js --network fuji
//      npx hardhat run scripts/awardAllCells.js --network avalanche

const hre = require("hardhat");
const { MEMBERS_ONLY: CONTRACT_ADDRESS } = require('./addresses');

const CHIPS_TO_AWARD = 100;

const ABI = [
  'function totalMinted() view returns (uint256)',
  'function batchAwardChips(uint256[] tokenIds, uint256[] amounts) external',
  'function getChips(uint256 tokenId) view returns (uint256)',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  console.log("Owner wallet:", owner.address);
  console.log("Contract:    ", CONTRACT_ADDRESS);
  console.log("Chips/Chad:  ", CHIPS_TO_AWARD);
  console.log("─".repeat(50));

  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, ABI, owner);

  const totalRaw = await contract.totalMinted();
  const total = Number(totalRaw);
  console.log(`Total minted: ${total} Chads\n`);

  if (total === 0) {
    console.log("No Chads minted yet. Nothing to do.");
    return;
  }

  const tokenIds = [];
  const amounts = [];
  for (let id = 1; id <= total; id++) {
    tokenIds.push(id);
    amounts.push(CHIPS_TO_AWARD);
  }

  console.log(`Awarding ${CHIPS_TO_AWARD} chips to tokens [${tokenIds.join(', ')}]...`);

  const tx = await contract.batchAwardChips(tokenIds, amounts);
  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed.toString()})`);

  // Spot-check a few
  for (const id of [tokenIds[0], tokenIds[tokenIds.length - 1]]) {
    const chips = (await contract.getChips(id)).toString();
    console.log(`Chad #${id} — chips: ${chips}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
