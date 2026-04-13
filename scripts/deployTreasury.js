/**
 * deployTreasury.js
 *
 * Deploys the Treasury contract, authorizes it in MembersOnly
 * (so it can call spendChips), and patches js/config.js.
 *
 * Usage:
 *   npx hardhat run scripts/deployTreasury.js --network fuji
 *   npx hardhat run scripts/deployTreasury.js --network avalanche
 *
 * Required env vars:
 *   PRIVATE_KEY — deployer / owner wallet
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { MEMBERS_ONLY: CONTRACT_ADDRESS } = require('./addresses');

const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nDeploying Treasury on [${network}]`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`MembersOnly:   ${CONTRACT_ADDRESS}\n`);

  // ── 1. Deploy Treasury ───────────────────────────────────────────────
  const Treasury = await hre.ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(CONTRACT_ADDRESS);
  await treasury.waitForDeployment();

  const treasuryAddress = await treasury.getAddress();
  console.log("Treasury deployed to:", treasuryAddress);

  // ── 2. Authorize Treasury in MembersOnly ─────────────────────────────
  console.log("\nAuthorizing Treasury in MembersOnly...");
  const contract = new hre.ethers.Contract(CONTRACT_ADDRESS, SET_GAME_CONTRACT_ABI, deployer);
  const tx = await contract.setGameContract(treasuryAddress, true);
  await tx.wait();
  console.log("  setGameContract(Treasury) ✓");

  // ── 3. Patch js/config.js ────────────────────────────────────────────
  const configPath = path.join(__dirname, '..', 'js', 'config.js');
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    config = config.replace(
      /export const TREASURY_ADDRESS\s*=\s*'[^']*'/,
      `export const TREASURY_ADDRESS         = '${treasuryAddress}'`
    );
    fs.writeFileSync(configPath, config, 'utf8');
    console.log("\nPatched js/config.js → TREASURY_ADDRESS =", treasuryAddress);
  } else {
    console.warn("\nWarning: js/config.js not found — update TREASURY_ADDRESS manually.");
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("Deployment complete!");
  console.log("  Network:      ", network);
  console.log("  Treasury:     ", treasuryAddress);
  console.log("  MembersOnly:   ✓ (authorized)");
  console.log("══════════════════════════════════════════════════\n");
  console.log("js/config.js has been updated. Commit and push to go live.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
