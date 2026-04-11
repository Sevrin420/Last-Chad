/**
 * queryMints.js
 * Reads all mint events from a contract and prints each token ID + recipient.
 *
 * Required env vars:
 *   CONTRACT_ADDRESS  — the ERC-721 contract to query
 *   NETWORK           — fuji | avalanche (default: fuji)
 */

const hre = require("hardhat");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  if (!contractAddress) throw new Error("CONTRACT_ADDRESS env var not set");

  const provider = hre.ethers.provider;
  const contract = new hre.ethers.Contract(contractAddress, ABI, provider);

  console.log("Querying mint events for:", contractAddress);
  console.log("Network:", hre.network.name);
  console.log("---");

  const filter = contract.filters.Transfer(ZERO_ADDRESS, null, null);
  const events = await contract.queryFilter(filter, 0, "latest");

  console.log("Total mints:", events.length);
  console.log("");
  console.log("Token ID | Wallet");
  console.log("---------|-----------------------------------------------");

  for (const e of events) {
    console.log(`#${e.args.tokenId.toString().padEnd(8)} | ${e.args.to}`);
  }

  // Also print unique wallets
  console.log("");
  const wallets = {};
  for (const e of events) {
    const addr = e.args.to.toLowerCase();
    if (!wallets[addr]) wallets[addr] = [];
    wallets[addr].push(e.args.tokenId.toString());
  }
  const unique = Object.entries(wallets);
  console.log("Unique wallets:", unique.length);
  console.log("");
  for (const [addr, tokens] of unique) {
    console.log(`${addr}  tokens: ${tokens.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
