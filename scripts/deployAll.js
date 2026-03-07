/**
 * deployAll.js
 *
 * Full redeploy of all Last Chad contracts:
 *   1. LastChad (ERC-721, cells-based leveling)
 *   2. LastChadItems (ERC-1155 items)
 *   3. QuestRewards (quest escrow + cell rewards)
 *
 * Wires all contracts together and patches js/config.js automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deployAll.js --network fuji
 *   npx hardhat run scripts/deployAll.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY      — deployer wallet
 *   ORACLE_ADDRESS   — (optional) Cloudflare Worker public key
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const SET_GAME_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  console.log("\n════════════════════════════════════════════");
  console.log("Last Chad — Full Redeploy");
  console.log("════════════════════════════════════════════");
  console.log(`Network:   ${network}`);
  console.log(`Deployer:  ${deployer.address}\n`);

  // ── 1. LastChad ──────────────────────────────────────────────────────────
  const baseURI = "https://lastchad.xyz/metadata/";
  console.log("1/3  Deploying LastChad...");
  const LastChad = await hre.ethers.getContractFactory("LastChad");
  const lastChad = await LastChad.deploy(baseURI);
  await lastChad.waitForDeployment();
  const lastChadAddress = await lastChad.getAddress();
  console.log("     LastChad deployed to:", lastChadAddress);

  // ── 2. LastChadItems ──────────────────────────────────────────────────────
  const itemsBaseURI = "https://lastchad.xyz/items/";
  console.log("\n2/3  Deploying LastChadItems...");
  const LastChadItems = await hre.ethers.getContractFactory("LastChadItems");
  const lastChadItems = await LastChadItems.deploy(itemsBaseURI);
  await lastChadItems.waitForDeployment();
  const itemsAddress = await lastChadItems.getAddress();
  console.log("     LastChadItems deployed to:", itemsAddress);

  // ── 3. QuestRewards ───────────────────────────────────────────────────────
  console.log("\n3/3  Deploying QuestRewards...");
  const QuestRewards = await hre.ethers.getContractFactory("QuestRewards");
  const questRewards = await QuestRewards.deploy(lastChadAddress);
  await questRewards.waitForDeployment();
  const questRewardsAddress = await questRewards.getAddress();
  console.log("     QuestRewards deployed to:", questRewardsAddress);

  // ── Wire: QuestRewards ← LastChadItems ───────────────────────────────────
  console.log("\nWiring contracts...");
  let tx = await questRewards.setLastChadItems(itemsAddress);
  await tx.wait();
  console.log("  QuestRewards.setLastChadItems ✓");

  // ── Wire: LastChad authorizes QuestRewards ────────────────────────────────
  const lcContract = new hre.ethers.Contract(lastChadAddress, SET_GAME_ABI, deployer);
  tx = await lcContract.setGameContract(questRewardsAddress, true);
  await tx.wait();
  console.log("  LastChad.setGameContract(QuestRewards) ✓");

  // ── Wire: LastChadItems authorizes QuestRewards ───────────────────────────
  const lcItemsContract = new hre.ethers.Contract(itemsAddress, SET_GAME_ABI, deployer);
  tx = await lcItemsContract.setGameContract(questRewardsAddress, true);
  await tx.wait();
  console.log("  LastChadItems.setGameContract(QuestRewards) ✓");

  // ── Oracle (optional) ─────────────────────────────────────────────────────
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (oracleAddress && hre.ethers.isAddress(oracleAddress)) {
    tx = await questRewards.setOracle(oracleAddress);
    await tx.wait();
    console.log("  QuestRewards.setOracle ✓ →", oracleAddress);
  } else {
    console.warn("  Oracle not set — add ORACLE_ADDRESS env var to wire it.");
  }

  // ── Seed quest configs ────────────────────────────────────────────────────
  // setQuestConfig(questId, cellReward, itemReward)
  console.log("\nSeeding quest configs...");
  tx = await questRewards.setQuestConfig(1, 10, 0);
  await tx.wait();
  console.log("  Quest 1 → 10 cells on completion ✓");

  // ── Patch js/config.js ───────────────────────────────────────────────────
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');

    config = config.replace(
      /export const CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `export const CONTRACT_ADDRESS         = '${lastChadAddress}'`
    );
    config = config.replace(
      /export const ITEMS_CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `export const ITEMS_CONTRACT_ADDRESS   = '${itemsAddress}'`
    );
    config = config.replace(
      /export const QUEST_REWARDS_ADDRESS\s*=\s*'[^']*'/,
      `export const QUEST_REWARDS_ADDRESS    = '${questRewardsAddress}'`
    );

    fs.writeFileSync(configPath, config, 'utf8');
    console.log("\nPatched js/config.js ✓");
  } else {
    console.warn("\nWarning: js/config.js not found — update addresses manually.");
  }

  // Patch js/quest-globals.js (runtime config for quest pages)
  const globalsPath = path.join(__dirname, '..', 'js', 'quest-globals.js');
  if (fs.existsSync(globalsPath)) {
    let globals = fs.readFileSync(globalsPath, 'utf8');
    globals = globals.replace(/var CONTRACT_ADDRESS\s*=\s*'[^']*'/, `var CONTRACT_ADDRESS = '${lastChadAddress}'`);
    globals = globals.replace(/var ITEMS_CONTRACT_ADDRESS\s*=\s*'[^']*'/, `var ITEMS_CONTRACT_ADDRESS = '${itemsAddress}'`);
    globals = globals.replace(/var QUEST_REWARDS_ADDRESS\s*=\s*'[^']*'/, `var QUEST_REWARDS_ADDRESS = '${questRewardsAddress}'`);
    fs.writeFileSync(globalsPath, globals, 'utf8');
    console.log("Patched js/quest-globals.js ✓");
  } else {
    console.warn("Warning: js/quest-globals.js not found — update addresses manually.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════");
  console.log("Deployment Complete!");
  console.log("════════════════════════════════════════════");
  console.log(`  Network:       ${network}`);
  console.log(`  LastChad:      ${lastChadAddress}`);
  console.log(`  Items:         ${itemsAddress}`);
  console.log(`  QuestRewards:  ${questRewardsAddress}`);
  console.log(`  Oracle:        ${oracleAddress ? "✓  " + oracleAddress : "⚠  not set"}`);
  console.log("════════════════════════════════════════════\n");
  console.log("Next steps:");
  console.log("  1. Commit and push js/config.js + js/quest-globals.js");
  if (!oracleAddress) {
    console.log("  3. Set oracle: ORACLE_ADDRESS=0x... npx hardhat run scripts/deployAll.js");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
