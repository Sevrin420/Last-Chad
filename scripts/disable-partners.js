/**
 * disable-partners.js
 * Tests each partner NFT contract's balanceOf and disables any that revert.
 * Run via GitHub Actions with OWNER_PRIVATE_KEY secret.
 */

// Run with: npx hardhat run scripts/disable-partners.js --network avalanche
// Requires PRIVATE_KEY env var set to owner wallet private key
const { ethers } = require('hardhat');

const CONTRACT_ADDRESS = '0xd8d1660cA70D7EF700A30ea071D8A01c6E451E78';
const ERC721_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const LASTCHAD_ABI = [
  'function getPartnerCount() view returns (uint256)',
  'function getPartner(uint256 partnerId) view returns (string name, address nftContract, bool active)',
  'function setPartnerActive(uint256 partnerId, bool active)',
];

// Test address — any valid wallet works for a balanceOf call
const TEST_ADDRESS = '0x0000000000000000000000000000000000000001';

async function main() {
  const [owner] = await ethers.getSigners();
  console.log('Owner:', owner.address);

  const chad = new ethers.Contract(CONTRACT_ADDRESS, LASTCHAD_ABI, owner);
  const provider = ethers.provider;

  const count = (await chad.getPartnerCount()).toNumber();
  console.log(`\nRegistered partners: ${count}`);

  for (let i = 1; i <= count; i++) {
    const [name, nftContract, active] = await chad.getPartner(i);
    if (!active) {
      console.log(`  [${i}] ${name} — already disabled, skipping`);
      continue;
    }

    process.stdout.write(`  [${i}] ${name} (${nftContract}) — testing balanceOf... `);
    try {
      const nft = new ethers.Contract(nftContract, ERC721_ABI, provider);
      await nft.balanceOf(TEST_ADDRESS);
      console.log('OK');
    } catch (err) {
      console.log(`BROKEN: ${err.reason || err.message}`);
      console.log(`       → Disabling partner ${i} (${name})...`);
      const tx = await chad.setPartnerActive(i, false);
      await tx.wait();
      console.log(`       ✓ Partner ${i} disabled. TX: ${tx.hash}`);
    }
  }

  console.log('\nDone. Re-run mint to verify.');
}

main().catch((err) => { console.error(err); process.exit(1); });
