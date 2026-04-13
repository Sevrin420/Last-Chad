/**
 * verifyAll.js
 *
 * Verifies all deployed Members Only contracts on Snowtrace (via Routescan).
 * Reads addresses from js/config.js automatically.
 *
 * Usage:
 *   npx hardhat run scripts/verifyAll.js --network fuji
 *   npx hardhat run scripts/verifyAll.js --network avalanche
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

function readConfig() {
  const configPath = path.join(__dirname, "..", "js", "config.js");
  const src = fs.readFileSync(configPath, "utf8");

  const get = (key) => {
    const m = src.match(new RegExp(`export const ${key}\\s*=\\s*'([^']+)'`));
    if (!m) throw new Error(`${key} not found in js/config.js`);
    return m[1];
  };

  const gambleMatch     = src.match(/export const GAMBLE_ADDRESS\s*=\s*'([^']*)'/);
  const marketMatch     = src.match(/export const MARKET_ADDRESS\s*=\s*'([^']*)'/);
  const tournamentMatch = src.match(/export const TOURNAMENT_ADDRESS\s*=\s*'([^']*)'/);
  return {
    membersOnly: get("CONTRACT_ADDRESS"),
    items:       get("ITEMS_CONTRACT_ADDRESS"),
    gamble:      gambleMatch ? gambleMatch[1] : '',
    market:      marketMatch ? marketMatch[1] : '',
    tournament:  tournamentMatch ? tournamentMatch[1] : '',
  };
}

async function verify(address, constructorArgs, label) {
  console.log(`\nVerifying ${label} at ${address}...`);
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log(`  ✓ ${label} verified`);
  } catch (err) {
    if (err.message.includes("Already Verified") || err.message.includes("already verified")) {
      console.log(`  ✓ ${label} already verified`);
    } else {
      console.error(`  ✗ ${label} failed:`, err.message);
    }
  }
}

async function main() {
  const network = hre.network.name;
  const cfg     = readConfig();

  console.log("\n════════════════════════════════════════════");
  console.log("Members Only — Contract Verification");
  console.log("════════════════════════════════════════════");
  console.log(`Network:        ${network}`);
  console.log(`MembersOnly:    ${cfg.membersOnly}`);
  console.log(`Items:          ${cfg.items}`);
  if (cfg.market)     console.log(`Market:         ${cfg.market}`);
  if (cfg.gamble)     console.log(`Gamble:         ${cfg.gamble}`);
  if (cfg.tournament) console.log(`Tournament:     ${cfg.tournament}`);

  await verify(cfg.membersOnly, ["https://lastchad.xyz/metadata/"], "MembersOnly");
  await verify(cfg.items,       ["https://lastchad.xyz/items/"],    "MembersOnlyItems");

  if (cfg.market) {
    const ownerAbi = ['function owner() view returns (address)'];
    const marketContract = new hre.ethers.Contract(cfg.market, ownerAbi, hre.ethers.provider);
    const marketOwner = await marketContract.owner();
    await verify(cfg.market, [marketOwner], "Market");
  } else {
    console.log("\nSkipping Market — MARKET_ADDRESS not set in js/config.js");
  }

  if (cfg.gamble) {
    const oracleAbi = ['function oracle() view returns (address)'];
    const gambleContract = new hre.ethers.Contract(cfg.gamble, oracleAbi, hre.ethers.provider);
    const gambleOracle = await gambleContract.oracle();
    await verify(cfg.gamble, [cfg.membersOnly, gambleOracle], "Gamble");
  } else {
    console.log("\nSkipping Gamble — GAMBLE_ADDRESS not set in js/config.js");
  }

  if (cfg.tournament) {
    await verify(cfg.tournament, [cfg.membersOnly], "Tournament");
  } else {
    console.log("\nSkipping Tournament — TOURNAMENT_ADDRESS not set in js/config.js");
  }

  console.log("\n════════════════════════════════════════════");
  console.log("Done. Check Snowtrace:");
  const base = network === "avalanche"
    ? "https://snowtrace.io/address"
    : "https://testnet.snowtrace.io/address";
  console.log(`  ${base}/${cfg.membersOnly}`);
  console.log(`  ${base}/${cfg.items}`);
  if (cfg.market)     console.log(`  ${base}/${cfg.market}`);
  if (cfg.gamble)     console.log(`  ${base}/${cfg.gamble}`);
  if (cfg.tournament) console.log(`  ${base}/${cfg.tournament}`);
  console.log("════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
