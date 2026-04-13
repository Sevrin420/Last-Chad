/**
 * deployAll.js
 *
 * Full redeploy of all Members Only contracts:
 *   1. MembersOnly (ERC-721)
 *   2. MembersOnlyItems (ERC-1155 items)
 *
 * Wires all contracts together and patches js/config.js automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deployAll.js --network fuji
 *   npx hardhat run scripts/deployAll.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY      — deployer wallet
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { MARKET: MARKET_ADDRESS } = require('./addresses');

const SET_GAME_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

const MARKET_ABI = [
  'function setApprovedContract(address nftContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  console.log("\n════════════════════════════════════════════");
  console.log("Members Only — Full Redeploy");
  console.log("════════════════════════════════════════════");
  console.log(`Network:   ${network}`);
  console.log(`Deployer:  ${deployer.address}\n`);

  // ── 1. MembersOnly ───────────────────────────────────────────────────────
  const baseURI = "https://lastchad.xyz/metadata/";
  console.log("1/2  Deploying MembersOnly...");
  const MembersOnly = await hre.ethers.getContractFactory("MembersOnly");
  const membersOnly = await MembersOnly.deploy(baseURI);
  await membersOnly.waitForDeployment();
  const membersOnlyAddress = await membersOnly.getAddress();
  console.log("     MembersOnly deployed to:", membersOnlyAddress);

  // ── 2. MembersOnlyItems ──────────────────────────────────────────────────
  const itemsBaseURI = "https://lastchad.xyz/items/";
  console.log("\n2/2  Deploying MembersOnlyItems...");
  const MembersOnlyItems = await hre.ethers.getContractFactory("MembersOnlyItems");
  const membersOnlyItems = await MembersOnlyItems.deploy(itemsBaseURI);
  await membersOnlyItems.waitForDeployment();
  const itemsAddress = await membersOnlyItems.getAddress();
  console.log("     MembersOnlyItems deployed to:", itemsAddress);

  // ── Wire: Market approves MembersOnly + Items ─────────────────────────────
  if (MARKET_ADDRESS && hre.ethers.isAddress(MARKET_ADDRESS)) {
    const market = new hre.ethers.Contract(MARKET_ADDRESS, MARKET_ABI, deployer);
    let tx = await market.setApprovedContract(membersOnlyAddress, true);
    await tx.wait();
    console.log("  Market.setApprovedContract(MembersOnly) ✓");
    tx = await market.setApprovedContract(itemsAddress, true);
    await tx.wait();
    console.log("  Market.setApprovedContract(Items) ✓");
  } else {
    console.warn("  Market address not set — skipping market approval.");
  }

  // ── Patch js/config.js ───────────────────────────────────────────────────
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');

    config = config.replace(
      /export const CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `export const CONTRACT_ADDRESS         = '${membersOnlyAddress}'`
    );
    config = config.replace(
      /export const ITEMS_CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `export const ITEMS_CONTRACT_ADDRESS   = '${itemsAddress}'`
    );

    fs.writeFileSync(configPath, config, 'utf8');
    console.log("\nPatched js/config.js ✓");
  } else {
    console.warn("\nWarning: js/config.js not found — update addresses manually.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════");
  console.log("Deployment Complete!");
  console.log("════════════════════════════════════════════");
  console.log(`  Network:       ${network}`);
  console.log(`  MembersOnly:   ${membersOnlyAddress}`);
  console.log(`  Items:         ${itemsAddress}`);
  console.log("════════════════════════════════════════════\n");
  console.log("Next steps:");
  console.log("  1. Deploy Gamble.sol and Tournament.sol separately");
  console.log("  2. Run authorizeContracts.js to wire game contracts");
  console.log("  3. Run validateContracts.js to confirm everything is wired");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
