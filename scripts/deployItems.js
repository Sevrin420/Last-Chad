const hre = require("hardhat");

async function main() {
  const baseURI = "https://membersonly.cc/items/";

  const Items = await hre.ethers.getContractFactory("MembersOnlyItems");
  const items = await Items.deploy(baseURI);
  await items.waitForDeployment();

  const address = await items.getAddress();
  console.log("MembersOnlyItems deployed to:", address);
  console.log("Base URI:", baseURI);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
