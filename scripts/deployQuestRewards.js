/**
 * deployQuestRewards.js
 *
 * Deploys the new QuestRewards contract, wires it to LastChad + LastChadItems,
 * and patches js/config.js with the new address automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deployQuestRewards.js --network fuji
 *   npx hardhat run scripts/deployQuestRewards.js --network avalanche
 *
 * Required env vars:
 *   PRIVATE_KEY  — deployer / game-owner wallet
 */

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

// ── Existing contract addresses ────────────────────────────────────────────
const LAST_CHAD_ADDRESS       = '0x27732900f9a87ced6a2ec5ce890d7ff58f882f76';
const LAST_CHAD_ITEMS_ADDRESS = '0x0ef84248f58be2ac72b8d2e4229fc4e8575d5947';

// ── Minimal ABIs needed just for the wiring calls ─────────────────────────
const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nDeploying QuestRewards on [${network}]`);
  console.log(`Deployer / game owner: ${deployer.address}`);
  console.log(`LastChad:              ${LAST_CHAD_ADDRESS}`);
  console.log(`LastChadItems:         ${LAST_CHAD_ITEMS_ADDRESS}\n`);

  // ── 1. Deploy QuestRewards ─────────────────────────────────────────────
  const QuestRewards = await hre.ethers.getContractFactory("QuestRewards");
  const questRewards = await QuestRewards.deploy(LAST_CHAD_ADDRESS);
  await questRewards.waitForDeployment();

  const questRewardsAddress = await questRewards.getAddress();
  console.log("QuestRewards deployed to:", questRewardsAddress);

  // ── 2. Wire LastChadItems into QuestRewards ────────────────────────────
  console.log("\nWiring LastChadItems into QuestRewards...");
  let tx = await questRewards.setLastChadItems(LAST_CHAD_ITEMS_ADDRESS);
  await tx.wait();
  console.log("  setLastChadItems ✓");

  // ── 3. Authorize QuestRewards in LastChad ─────────────────────────────
  console.log("Authorizing QuestRewards in LastChad...");
  const lastChad = new hre.ethers.Contract(
    LAST_CHAD_ADDRESS, SET_GAME_CONTRACT_ABI, deployer
  );
  tx = await lastChad.setGameContract(questRewardsAddress, true);
  await tx.wait();
  console.log("  lastChad.setGameContract ✓");

  // ── 4. Authorize QuestRewards in LastChadItems ────────────────────────
  console.log("Authorizing QuestRewards in LastChadItems...");
  const lastChadItems = new hre.ethers.Contract(
    LAST_CHAD_ITEMS_ADDRESS, SET_GAME_CONTRACT_ABI, deployer
  );
  tx = await lastChadItems.setGameContract(questRewardsAddress, true);
  await tx.wait();
  console.log("  lastChadItems.setGameContract ✓");

  // ── 5. Set oracle address ─────────────────────────────────────────────
  // ORACLE_ADDRESS must be the public address derived from the private key
  // stored as ORACLE_PRIVATE_KEY in Cloudflare Worker secrets.
  // Generate with: const w = ethers.Wallet.createRandom(); console.log(w.address, w.privateKey)
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (oracleAddress && hre.ethers.isAddress(oracleAddress)) {
    console.log("\nSetting oracle address...");
    tx = await questRewards.setOracle(oracleAddress);
    await tx.wait();
    console.log("  setOracle ✓ →", oracleAddress);
  } else {
    console.warn("\nSkipping setOracle — set ORACLE_ADDRESS env var to wire it automatically.");
    console.warn("  Run after deploy: questRewards.setOracle(<oracle address>)");
  }

  // ── 6. Seed quest configs ──────────────────────────────────────────────
  // setQuestConfig(questId, cellReward, itemReward)
  // XP is now computed and signed by the Worker — not configured here.
  console.log("\nSeeding quest configs...");
  tx = await questRewards.setQuestConfig(1, 0, 0);
  await tx.wait();
  console.log("  Quest 1 config set ✓  (no auto cell/item reward; XP via Worker)");

  // ── 7. Patch js/config.js with the new address ────────────────────────
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    config = config.replace(
      /export const QUEST_REWARDS_ADDRESS\s*=\s*'[^']*'/,
      `export const QUEST_REWARDS_ADDRESS    = '${questRewardsAddress}'`
    );
    fs.writeFileSync(configPath, config, 'utf8');
    console.log("\nPatched js/config.js → QUEST_REWARDS_ADDRESS =", questRewardsAddress);
  } else {
    console.warn("\nWarning: js/config.js not found — update QUEST_REWARDS_ADDRESS manually.");
  }

  // ── 8. Summary ────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════");
  console.log("Deployment complete!");
  console.log("  Network:       ", network);
  console.log("  QuestRewards:  ", questRewardsAddress);
  console.log("  LastChad auth: ✓");
  console.log("  Items auth:    ✓");
  console.log("  Quest 1 cfg:   ✓  (XP signed by Worker)");
  console.log("  Oracle:        ", oracleAddress ? "✓  " + oracleAddress : "⚠  not set yet");
  console.log("══════════════════════════════════════════════════\n");
  if (!oracleAddress) {
    console.log("Next: ORACLE_ADDRESS=<address> npx hardhat run scripts/deployQuestRewards.js");
    console.log("  Or call questRewards.setOracle(<address>) from admin.html\n");
  }
  console.log("js/config.js has been updated. Commit and push to go live.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
