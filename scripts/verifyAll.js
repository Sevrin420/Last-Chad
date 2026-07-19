/**
 * verifyAll.js — verify the 3 Club Nile contracts on Snowtrace (Routescan).
 *
 * Reads deployed addresses from js/config.js; constructor args mirror
 * deployEverything.js exactly. No private key needed (read-only).
 *
 *   npx hardhat run scripts/verifyAll.js --network avalanche
 *
 * Env (optional — only needed if oracle/team were changed AFTER deploy, since
 * verification must use the ORIGINAL constructor values; by default they're
 * read on-chain from the Casino, which is correct right after deploy):
 *   ORACLE_ADDRESS, TEAM_WALLET
 */
const hre = require("hardhat");
const { MEMBERS_ONLY, ITEMS, CASINO, READ_RPC } = require("./addresses");

// Must match the constructor args used in deployEverything.js
const MEMBERS_BASE_URI = "https://membersonly.cc/members-metadata/";
const ITEMS_BASE_URI   = "https://membersonly.cc/items/";

const isUnset = (a) => !a || /^0x0+$/.test(a);

async function verify(name, address, args) {
  if (isUnset(address)) { console.log(`\n⊘ ${name}: address not set in js/config.js — skipping`); return; }
  console.log(`\nVerifying ${name} @ ${address}`);
  console.log(`  args: ${JSON.stringify(args)}`);
  try {
    await hre.run("verify:verify", { address, constructorArguments: args });
    console.log(`  ✓ ${name} verified`);
  } catch (e) {
    const m = (e.message || "").toLowerCase();
    if (m.includes("already verified")) console.log(`  ✓ ${name} already verified`);
    else console.log(`  ✗ ${name}: ${e.message}`);
  }
}

async function main() {
  console.log("── Verifying Club Nile contracts on Snowtrace ──");
  console.log(`  MembersOnly:      ${MEMBERS_ONLY}`);
  console.log(`  MembersOnlyItems: ${ITEMS}`);
  console.log(`  Casino:           ${CASINO}`);

  // Casino needs oracle + teamWallet. Prefer env overrides; else read on-chain
  // (correct as long as they haven't been re-pointed since deploy).
  let oracle = process.env.ORACLE_ADDRESS;
  let team   = process.env.TEAM_WALLET;
  if ((!oracle || !team) && !isUnset(CASINO)) {
    const provider = new hre.ethers.JsonRpcProvider(READ_RPC);
    const casino = new hre.ethers.Contract(CASINO, [
      "function oracle() view returns (address)",
      "function teamWallet() view returns (address)",
    ], provider);
    if (!oracle) oracle = await casino.oracle();
    if (!team)   team   = await casino.teamWallet();
    console.log(`  (read on-chain) oracle=${oracle}  teamWallet=${team}`);
  }

  await verify("MembersOnly",      MEMBERS_ONLY, [MEMBERS_BASE_URI]);
  await verify("MembersOnlyItems", ITEMS,        [ITEMS_BASE_URI, MEMBERS_ONLY]);
  await verify("Casino",           CASINO,       [MEMBERS_ONLY, ITEMS, oracle, team]);

  console.log("\n── Done. Check https://snowtrace.io for each address. ──");
}

main().catch((e) => { console.error(e); process.exit(1); });
