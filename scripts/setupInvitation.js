/**
 * setupInvitation.js
 *
 * 1. Creates the "Invitation" item in MembersOnlyItems (stackable, free, unlimited)
 * 2. Sets the invitation item ID on MembersOnly
 * 3. Airdrops invitations to specified wallets
 *
 * Usage:
 *   npx hardhat run scripts/setupInvitation.js --network fuji
 *
 * Env vars:
 *   PRIVATE_KEY         — owner wallet
 *   AIRDROP_WALLETS     — comma-separated wallet addresses (optional)
 */

const hre = require("hardhat");
const { MEMBERS_ONLY, ITEMS } = require('./addresses');

const ITEMS_ABI = [
  'function createItem(string name, uint256 maxSupply, uint256 price, bool stackable, uint8 itemType, uint256 bonusAmount) returns (uint256)',
  'function airdrop(address to, uint256 itemId, uint256 quantity)',
  'function totalItems() view returns (uint256)',
];

const MEMBERS_ONLY_ABI = [
  'function setInvitationItemId(uint256 itemId)',
  'function invitationItemId() view returns (uint256)',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nSetup Invitation on [${network}]`);
  console.log(`Owner:          ${owner.address}`);
  console.log(`MembersOnly:    ${MEMBERS_ONLY}`);
  console.log(`Items:          ${ITEMS}\n`);

  const items = new hre.ethers.Contract(ITEMS, ITEMS_ABI, owner);
  const membersOnly = new hre.ethers.Contract(MEMBERS_ONLY, MEMBERS_ONLY_ABI, owner);

  // Check if invitation already exists
  let invItemId = Number(await membersOnly.invitationItemId());

  if (invItemId === 0) {
    // Create invitation item: stackable, free, unlimited supply, no bonus
    console.log("Creating Invitation item...");
    const tx = await items.createItem("Invitation", 0, 0, true, 0, 0);
    const receipt = await tx.wait();

    // Get the new item ID from totalItems
    invItemId = Number(await items.totalItems());
    console.log(`  Invitation created as item #${invItemId}`);

    // Set on MembersOnly
    const tx2 = await membersOnly.setInvitationItemId(invItemId);
    await tx2.wait();
    console.log(`  MembersOnly.setInvitationItemId(${invItemId}) ✓`);
  } else {
    console.log(`Invitation already exists as item #${invItemId}`);
  }

  // Airdrop to wallets
  const walletEnv = process.env.AIRDROP_WALLETS || '';
  const wallets = walletEnv.split(',').map(w => w.trim()).filter(w => hre.ethers.isAddress(w));

  if (wallets.length > 0) {
    console.log(`\nAirdropping invitations to ${wallets.length} wallet(s)...`);
    for (const wallet of wallets) {
      const tx = await items.airdrop(wallet, invItemId, 1);
      await tx.wait();
      console.log(`  ${wallet} ✓`);
    }
  } else {
    console.log("\nNo AIRDROP_WALLETS set — skipping airdrop.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
