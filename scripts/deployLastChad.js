/**
 * deployMembersOnly.js
 *
 * Re-deploys only the MembersOnly (ERC-721) contract.
 * Useful when the membership contract is updated without touching Items or Gamble.
 *
 * After deploy it:
 *   1. Patches CONTRACT_ADDRESS in js/config.js
 *
 * Usage:
 *   npx hardhat run scripts/deployLastChad.js --network fuji
 *   npx hardhat run scripts/deployLastChad.js --network avalanche
 *
 * Env vars:
 *   PRIVATE_KEY      — deployer wallet
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  const configPath = path.join(__dirname, '..', 'js', 'config.js');

  console.log("\n════════════════════════════════════════════");
  console.log("Members Only — MembersOnly contract redeploy");
  console.log("════════════════════════════════════════════");
  console.log(`Network:        ${network}`);
  console.log(`Deployer:       ${deployer.address}`);
  console.log();

  // ── Deploy MembersOnly ────────────────────────────────────────────────────
  const baseURI = "https://membersonly.cc/metadata/";
  console.log("Deploying MembersOnly...");
  const MembersOnly = await hre.ethers.getContractFactory("MembersOnly");
  const membersOnly = await MembersOnly.deploy(baseURI);
  await membersOnly.waitForDeployment();
  const membersOnlyAddress = await membersOnly.getAddress();
  console.log("MembersOnly deployed to:", membersOnlyAddress);

  // ── Patch js/config.js ────────────────────────────────────────────────────
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, 'utf8');
    config = config.replace(
      /export const CONTRACT_ADDRESS\s*=\s*'[^']*'/,
      `export const CONTRACT_ADDRESS         = '${membersOnlyAddress}'`
    );
    fs.writeFileSync(configPath, config, 'utf8');
    console.log("Patched js/config.js ✓");
  } else {
    console.warn("Warning: js/config.js not found — update CONTRACT_ADDRESS manually.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════");
  console.log("Deploy complete!");
  console.log("════════════════════════════════════════════");
  console.log(`  Network:       ${network}`);
  console.log(`  MembersOnly:   ${membersOnlyAddress}`);
  console.log("════════════════════════════════════════════\n");
  console.log("Next: run authorizeContracts.js to wire game contracts, then commit js/config.js.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
