/**
 * deployCraps.js
 *
 * Deploys the CrapsGame contract, authorizes it in LastChad,
 * and patches js/config.js with the new address.
 *
 * Usage:
 *   npx hardhat run scripts/deployCraps.js --network fuji
 *   npx hardhat run scripts/deployCraps.js --network avalanche
 *
 * Required env vars:
 *   PRIVATE_KEY  — deployer / game-owner wallet
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { LAST_CHAD: LAST_CHAD_ADDRESS } = require('./addresses');

const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nDeploying CrapsGame on [${network}]`);
  console.log(`Deployer / game owner: ${deployer.address}`);
  console.log(`LastChad:              ${LAST_CHAD_ADDRESS}\n`);

  // ── 1. Deploy CrapsGame ──────────────────────────────────────────────
  const CrapsGame = await hre.ethers.getContractFactory("CrapsGame");
  const craps = await CrapsGame.deploy(LAST_CHAD_ADDRESS);
  await craps.waitForDeployment();

  const crapsAddress = await craps.getAddress();
  console.log("CrapsGame deployed to:", crapsAddress);

  // ── 2. Authorize CrapsGame in LastChad ───────────────────────────────
  console.log("\nAuthorizing CrapsGame in LastChad...");
  const lastChad = new hre.ethers.Contract(
    LAST_CHAD_ADDRESS, SET_GAME_CONTRACT_ABI, deployer
  );
  const tx = await lastChad.setGameContract(crapsAddress, true);
  await tx.wait();
  console.log("  lastChad.setGameContract ✓");

  // ── 3. Patch js/config.js ────────────────────────────────────────────
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    // Add or update CRAPS_GAME_ADDRESS
    if (config.includes('CRAPS_GAME_ADDRESS')) {
      config = config.replace(
        /export const CRAPS_GAME_ADDRESS\s*=\s*'[^']*'/,
        `export const CRAPS_GAME_ADDRESS        = '${crapsAddress}'`
      );
    } else {
      // Insert after GAMBLE_ADDRESS line
      config = config.replace(
        /(export const GAMBLE_ADDRESS\s*=\s*'[^']*';)/,
        `$1\nexport const CRAPS_GAME_ADDRESS        = '${crapsAddress}';`
      );
    }
    fs.writeFileSync(configPath, config, 'utf8');
    console.log("\nPatched js/config.js → CRAPS_GAME_ADDRESS =", crapsAddress);
  } else {
    console.warn("\nWarning: js/config.js not found — update CRAPS_GAME_ADDRESS manually.");
  }

  // ── 4. Patch worker/wrangler.toml ────────────────────────────────────
  const wranglerPath = path.join(__dirname, '..', 'worker', 'wrangler.toml');
  if (fs.existsSync(wranglerPath)) {
    let wrangler = fs.readFileSync(wranglerPath, 'utf8');
    if (wrangler.includes('CRAPS_GAME_ADDRESS')) {
      wrangler = wrangler.replace(
        /CRAPS_GAME_ADDRESS\s*=\s*"[^"]*"/,
        `CRAPS_GAME_ADDRESS    = "${crapsAddress}"`
      );
    } else {
      wrangler = wrangler.replace(
        /(GAMBLE_ADDRESS\s*=\s*"[^"]*")/,
        `$1\nCRAPS_GAME_ADDRESS    = "${crapsAddress}"`
      );
    }
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log("Patched worker/wrangler.toml → CRAPS_GAME_ADDRESS =", crapsAddress);
  } else {
    console.warn("Warning: worker/wrangler.toml not found — update CRAPS_GAME_ADDRESS manually.");
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("Deployment complete!");
  console.log("  Network:          ", network);
  console.log("  CrapsGame:        ", crapsAddress);
  console.log("  LastChad auth:    ✓");
  console.log("══════════════════════════════════════════════════\n");
  console.log("js/config.js has been updated. Commit and push to go live.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
