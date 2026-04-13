/**
 * deployEverything.js
 *
 * One-click full deploy of ALL Members Only contracts:
 *   1. MembersOnly      (ERC-721 — membership NFTs)
 *   2. MembersOnlyItems (ERC-1155 — items)
 *   3. Market           (NFT marketplace)
 *   4. Gamble           (chip wagering)
 *   5. Tournament       (tournament system)
 *
 * After deploy:
 *   - Wires all cross-contract references (setGameContract, setApprovedContract)
 *   - Patches js/config.js with new addresses
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
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  const oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress || !hre.ethers.isAddress(oracleAddress)) {
    throw new Error("ORACLE_ADDRESS env var is required (non-zero address). Gamble requires oracle at deploy.");
  }

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║         Members Only — Full Protocol Deploy               ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:   ${network}`);
  console.log(`  Deployer:  ${deployer.address}`);
  console.log(`  Oracle:    ${oracleAddress}\n`);

  // ── 1. MembersOnly ──────────────────────────────────────────────────────
  const baseURI = "https://lastchad.xyz/metadata/";
  console.log("1/5  Deploying MembersOnly (ERC-721)...");
  const MembersOnly = await hre.ethers.getContractFactory("MembersOnly");
  const membersOnly = await MembersOnly.deploy(baseURI);
  await membersOnly.waitForDeployment();
  const membersOnlyAddress = await membersOnly.getAddress();
  console.log("     ✓ MembersOnly:", membersOnlyAddress);

  // ── 2. MembersOnlyItems ─────────────────────────────────────────────────
  const itemsBaseURI = "https://lastchad.xyz/items/";
  console.log("\n2/5  Deploying MembersOnlyItems (ERC-1155)...");
  const MembersOnlyItems = await hre.ethers.getContractFactory("MembersOnlyItems");
  const membersOnlyItems = await MembersOnlyItems.deploy(itemsBaseURI);
  await membersOnlyItems.waitForDeployment();
  const itemsAddress = await membersOnlyItems.getAddress();
  console.log("     ✓ MembersOnlyItems:", itemsAddress);

  // ── 3. Market ────────────────────────────────────────────────────────────
  console.log("\n3/5  Deploying Market...");
  const Market = await hre.ethers.getContractFactory("Market");
  const market = await Market.deploy(deployer.address);
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log("     ✓ Market:", marketAddress);

  // ── 4. Gamble (oracle required at construction) ─────────────────────────
  console.log("\n4/5  Deploying Gamble...");
  const Gamble = await hre.ethers.getContractFactory("Gamble");
  const gamble = await Gamble.deploy(membersOnlyAddress, oracleAddress);
  await gamble.waitForDeployment();
  const gambleAddress = await gamble.getAddress();
  console.log("     ✓ Gamble:", gambleAddress);

  // ── 5. Tournament ─────────────────────────────────────────────────────────
  console.log("\n5/5  Deploying Tournament...");
  const Tournament = await hre.ethers.getContractFactory("Tournament");
  const tournament = await Tournament.deploy(membersOnlyAddress);
  await tournament.waitForDeployment();
  const tournamentAddress = await tournament.getAddress();
  console.log("     ✓ Tournament:", tournamentAddress);

  // ════════════════════════════════════════════════════════════════════════
  // WIRING — connect all contracts together
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Wiring contracts ──────────────────────────────────────");
  let tx;

  // MembersOnly authorizes Gamble as a game contract
  const moGameAuth = new hre.ethers.Contract(membersOnlyAddress, SET_GAME_ABI, deployer);
  tx = await moGameAuth.setGameContract(gambleAddress, true);
  await tx.wait();
  console.log("  MembersOnly.setGameContract(Gamble)        ✓");

  // MembersOnly authorizes Tournament as a game contract
  tx = await moGameAuth.setGameContract(tournamentAddress, true);
  await tx.wait();
  console.log("  MembersOnly.setGameContract(Tournament)    ✓");

  // MembersOnlyItems authorizes Gamble as a game contract
  const itemsGameAuth = new hre.ethers.Contract(itemsAddress, SET_GAME_ABI, deployer);
  tx = await itemsGameAuth.setGameContract(gambleAddress, true);
  await tx.wait();
  console.log("  MembersOnlyItems.setGameContract(Gamble)   ✓");

  // MembersOnlyItems authorizes Tournament as a game contract
  tx = await itemsGameAuth.setGameContract(tournamentAddress, true);
  await tx.wait();
  console.log("  MembersOnlyItems.setGameContract(Tournament) ✓");

  // Market: approve MembersOnly + Items for trading
  const marketContract = new hre.ethers.Contract(marketAddress, MARKET_WIRE_ABI, deployer);
  tx = await marketContract.setApprovedContract(membersOnlyAddress, true);
  await tx.wait();
  console.log("  Market.setApprovedContract(MembersOnly)    ✓");

  tx = await marketContract.setApprovedContract(itemsAddress, true);
  await tx.wait();
  console.log("  Market.setApprovedContract(Items)          ✓");

  // ════════════════════════════════════════════════════════════════════════
  // PATCH CONFIG FILES
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── Patching config files ─────────────────────────────────");

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
    config = config.replace(
      /export const MARKET_ADDRESS\s*=\s*'[^']*'/,
      `export const MARKET_ADDRESS           = '${marketAddress}'`
    );
    config = config.replace(
      /export const GAMBLE_ADDRESS\s*=\s*'[^']*'/,
      `export const GAMBLE_ADDRESS           = '${gambleAddress}'`
    );

    if (config.includes('TOURNAMENT_ADDRESS')) {
      config = config.replace(/export const TOURNAMENT_ADDRESS\s*=\s*'[^']*'/, `export const TOURNAMENT_ADDRESS       = '${tournamentAddress}'`);
    } else {
      config = config.replace(
        /(export const GAMBLE_ADDRESS\s*=\s*'[^']*';?)/,
        `$1\nexport const TOURNAMENT_ADDRESS       = '${tournamentAddress}';`
      );
    }

    fs.writeFileSync(configPath, config, 'utf8');
    console.log("  js/config.js                             ✓  (5 addresses)");
  } else {
    console.warn("  ⚠ js/config.js not found");
  }

  const wranglerPath = path.join(__dirname, '..', 'worker', 'wrangler.toml');
  if (fs.existsSync(wranglerPath)) {
    let wrangler = fs.readFileSync(wranglerPath, 'utf8');
    wrangler = wrangler.replace(
      /CONTRACT_ADDRESS\s*=\s*"[^"]*"/,
      `CONTRACT_ADDRESS      = "${membersOnlyAddress}"`
    );
    wrangler = wrangler.replace(
      /GAMBLE_ADDRESS\s*=\s*"[^"]*"/,
      `GAMBLE_ADDRESS        = "${gambleAddress}"`
    );
    fs.writeFileSync(wranglerPath, wrangler, 'utf8');
    console.log("  worker/wrangler.toml                     ✓  (2 addresses)");
  } else {
    console.warn("  ⚠ worker/wrangler.toml not found");
  }

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║              Deployment Complete!                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`  Network:         ${network}`);
  console.log(`  MembersOnly:     ${membersOnlyAddress}`);
  console.log(`  MembersOnlyItems:${itemsAddress}`);
  console.log(`  Market:          ${marketAddress}`);
  console.log(`  Gamble:          ${gambleAddress}`);
  console.log(`  Tournament:      ${tournamentAddress}`);
  console.log(`  Oracle:          ✓  ${oracleAddress}`);
  console.log("");
  console.log("  Wiring:");
  console.log("    MembersOnly  ← authorized → Gamble       ✓");
  console.log("    MembersOnly  ← authorized → Tournament   ✓");
  console.log("    Items        ← authorized → Gamble       ✓");
  console.log("    Items        ← authorized → Tournament   ✓");
  console.log("    Market       ← approved   → MembersOnly  ✓");
  console.log("    Market       ← approved   → Items        ✓");
  console.log("");
  console.log("  Config files patched:");
  console.log("    js/config.js          (5 addresses)");
  console.log("    worker/wrangler.toml  (2 addresses)");
  console.log("════════════════════════════════════════════════════════════\n");
  console.log("Next: Commit config files, deploy Cloudflare Worker, verify on Snowtrace.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
