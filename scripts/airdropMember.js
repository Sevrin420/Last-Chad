/**
 * airdropMember.js
 *
 * Owner mints a Members Only NFT to a wallet and awards chips.
 *
 * Usage:
 *   AIRDROP_TO=0x... AIRDROP_CHIPS=200 npx hardhat run scripts/airdropMember.js --network fuji
 *
 * Env vars:
 *   PRIVATE_KEY    — owner wallet
 *   AIRDROP_TO     — recipient wallet address
 *   AIRDROP_CHIPS  — chips to award (default 0)
 */

const hre = require("hardhat");
const { MEMBERS_ONLY, ITEMS } = require('./addresses');

const MEMBERS_ONLY_ABI = [
  'function mint(uint256 quantity) payable',
  'function MINT_PRICE() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const ITEMS_ABI = [
  'function mintChips(address to, uint256 amount)',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const to = process.env.AIRDROP_TO;
  const chips = parseInt(process.env.AIRDROP_CHIPS || '0');

  if (!to || !hre.ethers.isAddress(to)) throw new Error('Set AIRDROP_TO env var');

  console.log(`\nAirdrop Member NFT on [${hre.network.name}]`);
  console.log(`Owner:  ${owner.address}`);
  console.log(`To:     ${to}`);
  console.log(`Chips:  ${chips}\n`);

  const membersOnly = new hre.ethers.Contract(MEMBERS_ONLY, MEMBERS_ONLY_ABI, owner);
  const mintPrice = await membersOnly.MINT_PRICE();

  // Mint 1 NFT (owner pays)
  console.log('Minting 1 NFT...');
  const tx = await membersOnly.mint(1, { value: mintPrice });
  await tx.wait();
  const tokenId = Number(await membersOnly.totalMinted());
  console.log(`  Minted token #${tokenId}`);

  // Transfer to recipient
  if (owner.address.toLowerCase() !== to.toLowerCase()) {
    console.log(`Transferring #${tokenId} to ${to}...`);
    const tx2 = await membersOnly.transferFrom(owner.address, to, tokenId);
    await tx2.wait();
    console.log('  Transferred ✓');
  }

  // Award chips
  if (chips > 0) {
    console.log(`Awarding ${chips} chips to ${to}...`);
    const items = new hre.ethers.Contract(ITEMS, ITEMS_ABI, owner);
    const tx3 = await items.mintChips(to, chips);
    await tx3.wait();
    console.log('  Chips awarded ✓');
  }

  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
