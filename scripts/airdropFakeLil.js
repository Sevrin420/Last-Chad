/**
 * airdropFakeLil.js
 * Airdrops Fake Lil NFTs to a recipient address.
 *
 * Required env vars:
 *   PRIVATE_KEY        — deployer/owner wallet private key
 *   FAKELIL_ADDRESS    — deployed FakeLil contract address
 *   RECIPIENT          — wallet address to receive the NFTs
 *   QUANTITY           — number of tokens to airdrop (default: 1)
 */

const hre = require("hardhat");

const FAKELIL_ABI = [
  "function airdrop(address[] calldata recipients) external",
  "function totalSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
];

async function main() {
  const contractAddress = process.env.FAKELIL_ADDRESS;
  const recipient       = process.env.RECIPIENT;
  const quantity        = parseInt(process.env.QUANTITY || "1", 10);

  if (!contractAddress) throw new Error("FAKELIL_ADDRESS env var not set");
  if (!recipient)       throw new Error("RECIPIENT env var not set");
  if (quantity < 1)     throw new Error("QUANTITY must be >= 1");

  const [owner] = await hre.ethers.getSigners();
  console.log("Owner:    ", owner.address);
  console.log("Contract: ", contractAddress);
  console.log("Recipient:", recipient);
  console.log("Quantity: ", quantity);

  const contract = new hre.ethers.Contract(contractAddress, FAKELIL_ABI, owner);

  const supply    = await contract.totalSupply();
  const maxSupply = await contract.MAX_SUPPLY();
  console.log(`\nSupply before: ${supply} / ${maxSupply}`);

  if (BigInt(supply) + BigInt(quantity) > BigInt(maxSupply)) {
    throw new Error(`Not enough supply — only ${BigInt(maxSupply) - BigInt(supply)} tokens remaining`);
  }

  // Build recipients array: same address repeated `quantity` times
  const recipients = Array(quantity).fill(recipient);

  console.log("\nSending airdrop transaction...");
  const tx = await contract.airdrop(recipients);
  console.log("Tx hash:", tx.hash);

  const receipt = await tx.wait();
  console.log(`\n✅ Airdrop confirmed (block ${receipt.blockNumber})`);
  console.log(`   ${quantity} Fake Lil NFT(s) sent to ${recipient}`);

  const supplyAfter = await contract.totalSupply();
  console.log(`   Supply after: ${supplyAfter} / ${maxSupply}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
