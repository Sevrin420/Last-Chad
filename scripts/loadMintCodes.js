/**
 * loadMintCodes.js
 * Loads the 100 pre-generated mint code hashes into LastChad.sol via addMintCodes().
 * Run via GitHub Actions after contract is deployed.
 *
 * Usage:
 *   npx hardhat run scripts/loadMintCodes.js --network fuji
 *   npx hardhat run scripts/loadMintCodes.js --network avalanche
 */

const hf = require('hardhat');
const { hashes } = require('./mintcodes-hashes.json');

async function main() {
  const [deployer] = await hf.ethers.getSigners();
  console.log('Loading mint codes from:', deployer.address);

  const address = process.env.LASTCHAD_ADDRESS;
  if (!address) throw new Error('Set LASTCHAD_ADDRESS env var');

  const LastChad = await hf.ethers.getContractAt('LastChad', address, deployer);

  // Load in batches of 25 to avoid gas limits
  const BATCH = 25;
  for (let i = 0; i < hashes.length; i += BATCH) {
    const batch = hashes.slice(i, i + BATCH);
    console.log(`Loading batch ${i / BATCH + 1}: codes ${i + 1}–${Math.min(i + BATCH, hashes.length)}`);
    const tx = await LastChad.addMintCodes(batch);
    await tx.wait();
    console.log(`  tx: ${tx.hash}`);
  }

  console.log(`\nDone. ${hashes.length} codes loaded on-chain.`);
}

main().catch(e => { console.error(e); process.exit(1); });
