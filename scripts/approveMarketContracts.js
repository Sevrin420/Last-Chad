const hre = require("hardhat");
const { MARKET: MARKET_ADDRESS, LAST_CHAD: LASTCHAD_ADDRESS, ITEMS: ITEMS_ADDRESS } = require('./addresses');

const MARKET_ABI = [
  "function setApprovedContract(address nftContract, bool approved) external"
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  console.log("Owner:", owner.address);

  const market = new hre.ethers.Contract(MARKET_ADDRESS, MARKET_ABI, owner);

  console.log("Approving LastChad (ERC-721)...");
  const tx1 = await market.setApprovedContract(LASTCHAD_ADDRESS, true);
  await tx1.wait();
  console.log("  Done:", tx1.hash);

  console.log("Approving LastChadItems (ERC-1155)...");
  const tx2 = await market.setApprovedContract(ITEMS_ADDRESS, true);
  await tx2.wait();
  console.log("  Done:", tx2.hash);

  console.log("Both contracts approved on Market.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
