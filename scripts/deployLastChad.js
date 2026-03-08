/**
 * deployLastChad.js
 *
 * Re-deploys only the LastChad (ERC-721) contract.
 * Useful when the character contract is updated (e.g. stat point changes)
 * without touching LastChadItems or QuestRewards.
 *
 * After deploy it:
 *   1. Re-authorizes the existing QuestRewards contract in the new LastChad
 *   2. Sets the oracle if ORACLE_ADDRESS env var is present
 *   3. Patches CONTRACT_ADDRESS in js/config.js and js/quest-globals.js
 *
 * Usage:
 *   npx hardhat run scripts/deployLastChad.js --network fuji
 *   npx hardhat run scripts/deployLastChad.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY      — deployer wallet
 *   ORACLE_ADDRESS   — (optional) Cloudflare Worker public key
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// Read the current QUEST_REWARDS_ADDRESS from js/config.js so we can
// re-authorize QuestRewards in the freshly-deployed LastChad.
function readCurrentAddress(configPath, key) {
  const src = fs.readFileSync(configPath, 'utf8');
  const m   = src.match(new RegExp(`export const ${key}\\s*=\\s*'([^']+)'`));
  return m ? m[1] : null;
}

const SET_GAME_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];
const SET_ORACLE_ABI = [
  'function setOracle(address oracle) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  const configPath  = path.join(__dirname, '..', 'js', 'config.js');
  const globalsPath = path.join(__dirname, '..', 'js', 'quest-globals.js');

  const existingQuestRewards = readCurrentAddress(configPath, 'QUEST_REWARDS_ADDRESS');
  const oracleAddress        = process.env.ORACLE_ADDRESS || null;

  console.log("\n════════════════════════════════════════════");
  console.log("Last Chad — LastChad contract redeploy");
  console.log("════════════════════════════════════════════");
  console.log(`Network:        ${network}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log(`QuestRewards:   ${existingQuestRewards || '(not found in config.js)'}`);
  console.log(`Oracle:         ${oracleAddress || '(not set)'}\n`);

  // ── Deploy LastChad ───────────────────────────────────────────────────────
  const baseURI = "https://lastchad.xyz/metadata/";
  console.log("Deploying LastChad...");
  const LastChad = await hre.ethers.getContractFactory("LastChad");
  const lastChad = await LastChad.deploy(baseURI);
  await lastChad.waitForDeployment();
  const lastChadAddress = await lastChad.getAddress();
  console.log("LastChad deployed to:", lastChadAddress);

  // ── Re-authorize QuestRewards ─────────────────────────────────────────────
  if (existingQuestRewards && hre.ethers.isAddress(existingQuestRewards)) {
    const lcContract = new hre.ethers.Contract(lastChadAddress, SET_GAME_ABI, deployer);
    const tx = await lcContract.setGameContract(existingQuestRewards, true);
    await tx.wait();
    console.log("LastChad.setGameContract(QuestRewards) ✓");
  } else {
    console.warn("Skipping QuestRewards authorization — address not found in config.js.");
    console.warn("Run 'authorize' target after deploy to wire the contracts.");
  }

  // ── Oracle (optional) ─────────────────────────────────────────────────────
  if (oracleAddress && hre.ethers.isAddress(oracleAddress)) {
    const lcWithOracle = new hre.ethers.Contract(lastChadAddress, SET_ORACLE_ABI, deployer);
    const tx = await lcWithOracle.setOracle(oracleAddress);
    await tx.wait();
    console.log("LastChad.setOracle ✓ →", oracleAddress);
  }

  // ── Patch js/config.js ────────────────────────────────────────────────────
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    config = config.replace(
      /export const CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `export const CONTRACT_ADDRESS         = '${lastChadAddress}'`
    );
    fs.writeFileSync(configPath, config, 'utf8');
    console.log("Patched js/config.js ✓");
  } else {
    console.warn("Warning: js/config.js not found — update CONTRACT_ADDRESS manually.");
  }

  // ── Patch js/quest-globals.js ─────────────────────────────────────────────
  if (fs.existsSync(globalsPath)) {
    let globals = fs.readFileSync(globalsPath, 'utf8');
    globals = globals.replace(
      /var CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `var CONTRACT_ADDRESS = '${lastChadAddress}'`
    );
    fs.writeFileSync(globalsPath, globals, 'utf8');
    console.log("Patched js/quest-globals.js ✓");
  } else {
    console.warn("Warning: js/quest-globals.js not found — update manually.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════");
  console.log("Deploy complete!");
  console.log("════════════════════════════════════════════");
  console.log(`  Network:       ${network}`);
  console.log(`  LastChad:      ${lastChadAddress}`);
  console.log(`  QuestRewards:  ${existingQuestRewards || '⚠  not set'}`);
  console.log("════════════════════════════════════════════\n");
  console.log("Next steps:");
  console.log("  1. Commit and push js/config.js + js/quest-globals.js");
  console.log("  2. QuestRewards.sol still points to old LastChad — redeploy");
  console.log("     QuestRewards too if you need it to call the new contract.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
