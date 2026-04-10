/**
 * setFakeLilBaseURI.js
 * Sets the metadata base URI on an already-deployed FakeLil contract.
 *
 * Required env vars:
 *   PRIVATE_KEY        — owner wallet private key
 *   FAKELIL_ADDRESS    — deployed FakeLil contract address
 *   BASE_URI           — base URI to set (e.g. https://lastchad.xyz/fake-lil/)
 */

const hre = require("hardhat");

const ABI = ["function setBaseURI(string calldata uri) external"];

async function main() {
  const contractAddress = process.env.FAKELIL_ADDRESS;
  const baseURI         = process.env.BASE_URI;

  if (!contractAddress) throw new Error("FAKELIL_ADDRESS env var not set");
  if (!baseURI)         throw new Error("BASE_URI env var not set");

  const [owner] = await hre.ethers.getSigners();
  const contract = new hre.ethers.Contract(contractAddress, ABI, owner);

  console.log("Setting base URI...");
  console.log("  Contract:", contractAddress);
  console.log("  URI:     ", baseURI);

  const tx = await contract.setBaseURI(baseURI);
  await tx.wait();

  console.log("✅ Base URI set. Tx:", tx.hash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
