/**
 * deployEverything.js
 *
 * One-click full deploy of ALL Last Chad contracts:
 *   1. LastChad         (ERC-721 — characters)
 *   2. LastChadItems    (ERC-1155 — items)
 *   3. QuestRewards     (quests + arcade)
 *   4. Market           (NFT marketplace)
 *   5. Gamble           (cell wagering)
 *
 * After deploy:
 *   - Wires all cross-contract references (setGameContract, setLastChadItems,
 *     setOracle, setApprovedContract, setLastChadContract)
 *   - Seeds default quest config (quest 1 → 10 cells)
 *   - Patches js/config.js and js/quest-globals.js with new addresses
 *
 * Usage:
 *   npx hardhat run scripts/deployEverything.js --network fuji
 *   npx hardhat run scripts/deployEverything.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY      — deployer wallet
 *   ORACLE_ADDRESS   — Cloudflare Worker public key (REQUIRED for Gamble constructor)
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const SET_GAME_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

const MARKET_WIRE_ABI = [
  'function setApprovedContract(address nftContract, bool approved) external',
  'function setLastChadContract(address _lastChad) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress || !hre.ethers.isAddress(oracleAddress)) {
    throw new Error("ORACLE_ADDRESS env var is required (non-zero address). Gamble requires oracle at deploy.");
  }

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║         Last Chad — Full Protocol Deploy                  ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:   ${network}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Oracle:    ${oracleAddress}\n`);

  // ── 1. LastChad ──────────────────────────────────────────────────────────
  const baseURI = "https://lastchad.xyz/metadata/";
  console.log("1/5  Deploying LastChad (ERC-721)...");
  const LastChad = await hre.ethers.getContractFactory("LastChad");
  const lastChad = await LastChad.deploy(baseURI);
  await lastChad.waitForDeployment();
  const lastChadAddress = await lastChad.getAddress();
  console.log("     ✓ LastChad:", lastChadAddress);

  // ── 2. LastChadItems ─────────────────────────────────────────────────────
  const itemsBaseURI = "https://lastchad.xyz/items/";
  console.log("\n2/5  Deploying LastChadItems (ERC-1155)...");
  const LastChadItems = await hre.ethers.getContractFactory("LastChadItems");
  const lastChadItems = await LastChadItems.deploy(itemsBaseURI);
  await lastChadItems.waitForDeployment();
  const itemsAddress = await lastChadItems.getAddress();
  console.log("     ✓ LastChadItems:", itemsAddress);

  // ── 3. QuestRewards ──────────────────────────────────────────────────────
  console.log("\n3/5  Deploying QuestRewards...");
  const QuestRewards = await hre.ethers.getContractFactory("QuestRewards");
  const questRewards = await QuestRewards.deploy(lastChadAddress);
  await questRewards.waitForDeployment();
  const questRewardsAddress = await questRewards.getAddress();
  console.log("     ✓ QuestRewards:", questRewardsAddress);

  // ── 4. Market ────────────────────────────────────────────────────────────
  console.log("\n4/5  Deploying Market...");
  const Market = await hre.ethers.getContractFactory("Market");
  const market = await Market.deploy(deployer.address);
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log("     ✓ Market:", marketAddress);

  // ── 5. Gamble (oracle required at construction) ─────────────────────────
  console.log("\n5/5  Deploying Gamble...");
  const Gamble = await hre.ethers.getContractFactory("Gamble");
  const gamble = await Gamble.deploy(lastChadAddress, oracleAddress);
  await gamble.waitForDeployment();
  const gambleAddress = await gamble.getAddress();
  console.log("     ✓ Gamble:", gambleAddress);

  // ════════════════════════════════════════════════════════════════════════
  // WIRING — connect all contracts together
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Wiring contracts ──────────────────────────────────────");
  let tx;

  // QuestRewards needs to know about Items
  tx = await questRewards.setLastChadItems(itemsAddress);
  await tx.wait();
  console.log("  QuestRewards.setLastChadItems           ✓");

  // LastChad authorizes QuestRewards as a game contract
  const lcGameAuth = new hre.ethers.Contract(lastChadAddress, SET_GAME_ABI, deployer);
  tx = await lcGameAuth.setGameContract(questRewardsAddress, true);
  await tx.wait();
  console.log("  LastChad.setGameContract(QuestRewards)  ✓");

  // LastChad authorizes Gamble as a game contract
  tx = await lcGameAuth.setGameContract(gambleAddress, true);
  await tx.wait();
  console.log("  LastChad.setGameContract(Gamble)         ✓");

  // LastChadItems authorizes QuestRewards as a game contract
  const itemsGameAuth = new hre.ethers.Contract(itemsAddress, SET_GAME_ABI, deployer);
  tx = await itemsGameAuth.setGameContract(questRewardsAddress, true);
  await tx.wait();
  console.log("  LastChadItems.setGameContract(QuestRewards) ✓");

  // Market: approve LastChad + Items for trading, set LastChad reference
  const marketContract = new hre.ethers.Contract(marketAddress, MARKET_WIRE_ABI, deployer);
  tx = await marketContract.setApprovedContract(lastChadAddress, true);
  await tx.wait();
  console.log("  Market.setApprovedContract(LastChad)     ✓");

  tx = await marketContract.setApprovedContract(itemsAddress, true);
  await tx.wait();
  console.log("  Market.setApprovedContract(Items)        ✓");

  tx = await marketContract.setLastChadContract(lastChadAddress);
  await tx.wait();
  console.log("  Market.setLastChadContract(LastChad)     ✓");

  // Oracle for QuestRewards (Gamble oracle was set in constructor)
  tx = await questRewards.setOracle(oracleAddress);
  await tx.wait();
  console.log("  QuestRewards.setOracle                  ✓ →", oracleAddress);
  console.log("  Gamble.oracle (set at deploy)            ✓ →", oracleAddress);

  // ── Seed quest configs ─────────────────────────────────────────────────
  console.log("\n── Seeding quest configs ─────────────────────────────────");
  tx = await questRewards.setQuestConfig(1, 10, 0);
  await tx.wait();
  console.log("  Quest 1 → 10 cells, no item              ✓");

  // ════════════════════════════════════════════════════════════════════════
  // PATCH CONFIG FILES — update all address references
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Patching config files ─────────────────────────────────");

  // Patch js/config.js (ES module — used by all main HTML pages)
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
    config = config.replace(
      /export const MARKET_ADDRESS\s*=\s*'[^']*'/,
      `export const MARKET_ADDRESS           = '${marketAddress}'`
    );
    config = config.replace(
      /export const GAMBLE_ADDRESS\s*=\s*'[^']*'/,
      `export const GAMBLE_ADDRESS           = '${gambleAddress}'`
    );

    fs.writeFileSync(configPath, config, 'utf8');
    console.log("  js/config.js                             ✓  (5 addresses)");
  } else {
    console.warn("  ⚠ js/config.js not found");
  }

  // Patch worker/wrangler.toml (Cloudflare Worker — needs contract addresses for on-chain reads)
  const wranglerPath = path.join(__dirname, '..', 'worker', 'wrangler.toml');
  if (fs.existsSync(wranglerPath)) {
    let wrangler = fs.readFileSync(wranglerPath, 'utf8');
    wrangler = wrangler.replace(
      /LASTCHAD_ADDRESS\s*=\s*"[^"]*"/,
      `LASTCHAD_ADDRESS      = "${lastChadAddress}"`
    );
    wrangler = wrangler.replace(
      /QUEST_REWARDS_ADDRESS\s*=\s*"[^"]*"/,
      `QUEST_REWARDS_ADDRESS = "${questRewardsAddress}"`
    );
    wrangler = wrangler.replace(
      /GAMBLE_ADDRESS\s*=\s*"[^"]*"/,
      `GAMBLE_ADDRESS        = "${gambleAddress}"`
    );
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log("  worker/wrangler.toml                     ✓  (3 addresses)");
  } else {
    console.warn("  ⚠ worker/wrangler.toml not found");
  }

  // Patch js/quest-globals.js (vanilla JS — used by generated quest pages)
  const globalsPath = path.join(__dirname, '..', 'js', 'quest-globals.js');
  if (fs.existsSync(globalsPath)) {
    let globals = fs.readFileSync(globalsPath, 'utf8');
    globals = globals.replace(
      /var CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `var CONTRACT_ADDRESS = '${lastChadAddress}'`
    );
    globals = globals.replace(
      /var ITEMS_CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `var ITEMS_CONTRACT_ADDRESS = '${itemsAddress}'`
    );
    globals = globals.replace(
      /var QUEST_REWARDS_ADDRESS\s*=\s*'[^']*'/,
      `var QUEST_REWARDS_ADDRESS = '${questRewardsAddress}'`
    );
    fs.writeFileSync(globalsPath, globals, 'utf8');
    console.log("  js/quest-globals.js                      ✓  (3 addresses)");
  } else {
    console.warn("  ⚠ js/quest-globals.js not found");
  }

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              Deployment Complete!                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:         ${network}`);
  console.log(`  LastChad:        ${lastChadAddress}`);
  console.log(`  LastChadItems:   ${itemsAddress}`);
  console.log(`  QuestRewards:    ${questRewardsAddress}`);
  console.log(`  Market:          ${marketAddress}`);
  console.log(`  Gamble:          ${gambleAddress}`);
  console.log(`  Oracle:          ✓  ${oracleAddress}`);
  console.log("");
  console.log("  Wiring:");
  console.log("    LastChad ← authorized → QuestRewards  ✓");
  console.log("    LastChad ← authorized → Gamble        ✓");
  console.log("    Items    ← authorized → QuestRewards  ✓");
  console.log("    Market   ← approved   → LastChad      ✓");
  console.log("    Market   ← approved   → Items         ✓");
  console.log("    Market   ← lastChad   → LastChad      ✓");
  console.log("");
  console.log("  Config files patched:");
  console.log("    js/config.js          (5 addresses)");
  console.log("    js/quest-globals.js   (3 addresses)");
  console.log("    worker/wrangler.toml  (3 addresses)");
  console.log("════════════════════════════════════════════════════════════\n");
  console.log("Next: Commit config files, deploy Cloudflare Worker, verify on Snowtrace.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
