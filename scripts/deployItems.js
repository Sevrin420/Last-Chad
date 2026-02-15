const hre = require("hardhat");

async function main() {
  const baseURI = "https://lastchad.xyz/items/";

  const Items = await hre.ethers.getContractFactory("LastChadItems");
  const items = await Items.deploy(baseURI);
  await items.waitForDeployment();

  const address = await items.getAddress();
  console.log("LastChadItems deployed to:", address);
  console.log("Base URI:", baseURI);
  console.log("Item #1 (Cindy's Code) seeded at deployment.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
