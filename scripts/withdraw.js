/**
 * withdraw.js
 * Calls withdraw() on MembersOnly to send all collected AVAX to the owner wallet.
 * Run via GitHub Actions with OWNER_PRIVATE_KEY secret.
 */

const { ethers } = require('hardhat');

const CONTRACT_ADDRESS = '0xd8d166DcA70D7EF700A30ea071D8A01c6E451E78';
const ABI = [
  'function withdraw()',
  'function owner() view returns (address)',
];

async function main() {
  const [owner] = await ethers.getSigners();
  console.log('Withdrawing as:', owner.address);

  const chad = new ethers.Contract(CONTRACT_ADDRESS, ABI, owner);

  // Confirm caller is owner
  const contractOwner = await chad.owner();
  if (owner.address.toLowerCase() !== contractOwner.toLowerCase()) {
    throw new Error(`Caller ${owner.address} is not the contract owner (${contractOwner})`);
  }

  const balanceBefore = await ethers.provider.getBalance(CONTRACT_ADDRESS);
  console.log('Contract balance:', ethers.formatEther(balanceBefore), 'AVAX');

  if (balanceBefore === 0n) {
    console.log('Nothing to withdraw.');
    return;
  }

  const tx = await chad.withdraw();
  console.log('TX sent:', tx.hash);
  await tx.wait();
  console.log('✓ Withdrawn', ethers.formatEther(balanceBefore), 'AVAX to', owner.address);
}

main().catch((err) => { console.error(err); process.exit(1); });
