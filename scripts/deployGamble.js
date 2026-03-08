/**
 * deployGamble.js
 *
 * Deploys the Gamble contract, authorizes it in LastChad,
 * and patches js/config.js with the new address automatically.
 *
 * Usage:
 *   npx hardhat run scripts/deployGamble.js --network fuji
 *   npx hardhat run scripts/deployGamble.js --network avalanche
 *
 * Required env vars:
 *   PRIVATE_KEY  — deployer / game-owner wallet
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const LAST_CHAD_ADDRESS = '0xcE6D7bC4cAdfafc4cAe6BB86fD70ea206bDe884f';

const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nDeploying Gamble on [${network}]`);
  console.log(`Deployer / game owner: ${deployer.address}`);
  console.log(`LastChad:              ${LAST_CHAD_ADDRESS}\n`);

  // ── 1. Deploy Gamble ───────────────────────────────────────────────────
  const Gamble = await hre.ethers.getContractFactory("Gamble");
  const gamble = await Gamble.deploy(LAST_CHAD_ADDRESS);
  await gamble.waitForDeployment();

  const gambleAddress = await gamble.getAddress();
  console.log("Gamble deployed to:", gambleAddress);

  // ── 2. Authorize Gamble in LastChad ────────────────────────────────────
  console.log("\nAuthorizing Gamble in LastChad...");
  const lastChad = new hre.ethers.Contract(
    LAST_CHAD_ADDRESS, SET_GAME_CONTRACT_ABI, deployer
  );
  const tx = await lastChad.setGameContract(gambleAddress, true);
  await tx.wait();
  console.log("  lastChad.setGameContract ✓");

  // ── 3. Set oracle address ──────────────────────────────────────────────
  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (oracleAddress && hre.ethers.isAddress(oracleAddress)) {
    console.log("\nSetting oracle address...");
    const SET_ORACLE_ABI = ['function setOracle(address oracle) external'];
    const gambleWrite = new hre.ethers.Contract(gambleAddress, SET_ORACLE_ABI, deployer);
    const oracleTx = await gambleWrite.setOracle(oracleAddress);
    await oracleTx.wait();
    console.log("  setOracle ✓ →", oracleAddress);
  } else {
    console.warn("\nSkipping setOracle — set ORACLE_ADDRESS env var to wire it automatically.");
    console.warn("  resolveGame() will skip signature checks until oracle is set.");
  }

  // ── 4. Patch js/config.js ──────────────────────────────────────────────
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    config = config.replace(
      /export const GAMBLE_ADDRESS\s*=\s*'[^']*'/,
      `export const GAMBLE_ADDRESS           = '${gambleAddress}'`
    );
    fs.writeFileSync(configPath, config, 'utf8');
    console.log("\nPatched js/config.js → GAMBLE_ADDRESS =", gambleAddress);
  } else {
    console.warn("\nWarning: js/config.js not found — update GAMBLE_ADDRESS manually.");
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("Deployment complete!");
  console.log("  Network:          ", network);
  console.log("  Gamble:           ", gambleAddress);
  console.log("  LastChad auth:    ✓");
  console.log("  Oracle:           ", oracleAddress ? "✓  " + oracleAddress : "⚠  not set (resolveGame open)");
  console.log("══════════════════════════════════════════════════\n");
  console.log("js/config.js has been updated. Commit and push to go live.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
