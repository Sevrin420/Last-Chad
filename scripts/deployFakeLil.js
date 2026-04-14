/**
 * deployFakeLil.js
 * Deploys the FakeLil ERC-721 contract.
 * Run via: npx hardhat run scripts/deployFakeLil.js --network <fuji|avalanche>
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance: ", hre.ethers.formatEther(balance), "AVAX");

  console.log("\nDeploying FakeLil...");
  const FakeLil = await hre.ethers.getContractFactory("FakeLil");
  const contract = await FakeLil.deploy(deployer.address);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ FakeLil deployed!");
  console.log("   Address:", address);
  console.log("   Network:", hre.network.name);
  console.log("\nNext steps:");
  console.log("  1. Upload NFT images to your hosting (e.g. membersonly.cc/fake-lil/{id}.png)");
  console.log("  2. Create metadata JSON files (one per token, 1–20)");
  console.log("  3. Call setBaseURI('<your-metadata-base-url>') on the contract");
  console.log("  4. Open public mint");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
