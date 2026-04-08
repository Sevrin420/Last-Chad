/**
 * registerPartners.js
 *
 * Registers all partner NFT collections on the deployed LastChad contract.
 * Partners are read from partnernft.md.
 *
 * Usage:
 *   npx hardhat run scripts/registerPartners.js --network avalanche
 */

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

const PARTNERS = [
  { name: "Little Burn",  address: "0xf3513f263994a3536cc0a684209013d6808fe443" },
  { name: "Nochillio",    address: "0x204b3ee3f9bdcde258ba3f74de76ea8eedf0a36a" },
  { name: "The Salvors",  address: "0xce4fee23ab35d0d9a4b6b644881ddd8adebeb300" },
  { name: "Lucid RED",    address: "0x4160c72898bb4ebafe2612d76777008e78880478" },
  { name: "The Bobs",     address: "0x66e82a463e47f0656a45f136368cf62686d2a01f" },
];

function readLastChadAddress() {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const m = src.match(/export const CONTRACT_ADDRESS\s*=\s*'([^']+)'/);
  if (!m) throw new Error("CONTRACT_ADDRESS not found in js/config.js");
  return m[1];
}

async function main() {
  const lastChadAddress = readLastChadAddress();
  const [deployer] = await hre.ethers.getSigners();

  console.log("\n════════════════════════════════════════════");
  console.log("Last Chad — Register Partner NFTs");
  console.log("════════════════════════════════════════════");
  console.log(`Network:   ${hre.network.name}`);
  console.log(`Contract:  ${lastChadAddress}`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Partners:  ${PARTNERS.length}`);

  const LastChad = await hre.ethers.getContractFactory("LastChad");
  const contract = LastChad.attach(lastChadAddress);

  // Check how many partners are already registered
  const existingCount = await contract.getPartnerCount();
  console.log(`\nAlready registered: ${existingCount}`);

  if (existingCount >= PARTNERS.length) {
    console.log("All partners already registered. Nothing to do.");
    return;
  }

  for (let i = Number(existingCount); i < PARTNERS.length; i++) {
    const { name, address } = PARTNERS[i];
    console.log(`\nRegistering ${name} (${address})...`);
    const tx = await contract.registerPartner(name, address);
    await tx.wait();
    console.log(`  ✓ ${name} registered`);
  }

  const finalCount = await contract.getPartnerCount();
  console.log(`\n════════════════════════════════════════════`);
  console.log(`Done. ${finalCount} partners registered on-chain.`);
  console.log(`════════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
