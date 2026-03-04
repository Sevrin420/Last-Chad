const hre = require("hardhat");

const MARKET_ADDRESS       = '0x2648fce03fe383c4a1d1a4c21fa59a0b9f35243d';
const LASTCHAD_ADDRESS     = '0xE6A490A8D7fd9AAa70d095CC3e28a4974f9AfcE2';
const ITEMS_ADDRESS        = '0xf84b280b2f501b9433319f1c8eee5595c5c60b34';

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
