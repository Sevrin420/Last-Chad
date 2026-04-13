/**
 * validateContracts.js
 *
 * Read-only on-chain validation for all deployed Members Only contracts.
 * Confirms each contract is live and correctly wired together.
 * No private key or gas required.
 *
 * Addresses read from js/config.js automatically.
 *
 * Usage:
 *   npx hardhat run scripts/validateContracts.js --network fuji
 *   npx hardhat run scripts/validateContracts.js --network avalanche
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Addresses ────────────────────────────────────────────────────────────────

function readConfig() {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8");
  const get = (key, required = true) => {
    const m = src.match(new RegExp(`export const ${key}\\s*=\\s*'([^']+)'`));
    if (!m && required) throw new Error(`${key} not found in js/config.js`);
    return m ? m[1] : '';
  };
  return {
    membersOnly: get("CONTRACT_ADDRESS"),
    items:       get("ITEMS_CONTRACT_ADDRESS"),
    market:      get("MARKET_ADDRESS",    false),
    gamble:      get("GAMBLE_ADDRESS",    false),
    tournament:  get("TOURNAMENT_ADDRESS", false),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label, value) {
  console.log(`  ✓  ${label}: ${value}`);
  passed++;
}

function fail(label, err) {
  console.log(`  ✗  ${label}: ${err}`);
  failed++;
}

async function check(label, fn) {
  try {
    const result = await fn();
    ok(label, result);
  } catch (e) {
    fail(label, e.message.split("\n")[0]);
  }
}

// ── Contract ABIs (view-only) ─────────────────────────────────────────────────

const MEMBERS_ONLY_ABI = [
  'function totalMinted() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function name() view returns (string)',
  'function authorizedGame(address) view returns (bool)',
  'function owner() view returns (address)',
];

const ITEMS_ABI = [
  'function getItem(uint256 itemId) view returns (string name, uint256 maxSupply, uint256 minted, uint256 price, bool stackable, bool active)',
  'function authorizedGame(address) view returns (bool)',
  'function owner() view returns (address)',
];

const MARKET_ABI = [
  'function feeBps() view returns (uint256)',
  'function owner() view returns (address)',
];

const GAMBLE_ABI = [
  'function membersOnly() view returns (address)',
  'function oracle() view returns (address)',
  'function gameOwner() view returns (address)',
  'function minWager() view returns (uint256)',
  'function maxWager() view returns (uint256)',
];

const TOURNAMENT_ABI = [
  'function membersOnly() view returns (address)',
  'function owner() view returns (address)',
  'function nextTournamentId() view returns (uint256)',
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const network = hre.network.name;
  const cfg     = readConfig();
  const p       = hre.ethers.provider;

  console.log("\n════════════════════════════════════════════════════════");
  console.log("Members Only — On-Chain Contract Validation");
  console.log("════════════════════════════════════════════════════════");
  console.log(`Network:        ${network}`);
  console.log(`MembersOnly:    ${cfg.membersOnly}`);
  console.log(`Items:          ${cfg.items}`);
  if (cfg.market)     console.log(`Market:         ${cfg.market}`);
  if (cfg.gamble)     console.log(`Gamble:         ${cfg.gamble}`);
  if (cfg.tournament) console.log(`Tournament:     ${cfg.tournament}`);
  console.log("────────────────────────────────────────────────────────");

  // ── 1. MembersOnly ────────────────────────────────────────────────────────
  console.log("\n[1] MembersOnly");
  const mo = new hre.ethers.Contract(cfg.membersOnly, MEMBERS_ONLY_ABI, p);
  await check("bytecode deployed",   () => p.getCode(cfg.membersOnly).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
  await check("name()",              () => mo.name());
  await check("MAX_SUPPLY()",        () => mo.MAX_SUPPLY().then(v => v.toString()));
  await check("totalMinted()",       () => mo.totalMinted().then(v => v.toString()));
  await check("owner()",             () => mo.owner());
  if (cfg.gamble) {
    await check("Gamble authorized", () => mo.authorizedGame(cfg.gamble).then(v => { if (!v) throw new Error("NOT authorized"); return "yes"; }));
  }
  if (cfg.tournament) {
    await check("Tournament authorized", () => mo.authorizedGame(cfg.tournament).then(v => { if (!v) throw new Error("NOT authorized"); return "yes"; }));
  }

  // ── 2. MembersOnlyItems ───────────────────────────────────────────────────
  console.log("\n[2] MembersOnlyItems");
  const items = new hre.ethers.Contract(cfg.items, ITEMS_ABI, p);
  await check("bytecode deployed",   () => p.getCode(cfg.items).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
  await check("owner()",             () => items.owner());

  // ── 3. Market ──────────────────────────────────────────────────────────────
  if (cfg.market) {
    console.log("\n[3] Market");
    const mkt = new hre.ethers.Contract(cfg.market, MARKET_ABI, p);
    await check("bytecode deployed", () => p.getCode(cfg.market).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
    await check("owner()",           () => mkt.owner());
    await check("feeBps()",          () => mkt.feeBps().then(v => `${v.toString()} bps`));
  } else {
    console.log("\n[3] Market — skipped (MARKET_ADDRESS not set)");
  }

  // ── 4. Gamble ──────────────────────────────────────────────────────────────
  if (cfg.gamble) {
    console.log("\n[4] Gamble");
    const gmbl = new hre.ethers.Contract(cfg.gamble, GAMBLE_ABI, p);
    await check("bytecode deployed",        () => p.getCode(cfg.gamble).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
    await check("gameOwner()",              () => gmbl.gameOwner());
    await check("membersOnly() correct",    () => gmbl.membersOnly().then(addr => {
      if (addr.toLowerCase() !== cfg.membersOnly.toLowerCase()) throw new Error(`points to ${addr}`);
      return "correct";
    }));
    await check("oracle() is set",          () => gmbl.oracle().then(addr => {
      if (addr === "0x0000000000000000000000000000000000000000") throw new Error("oracle not set");
      return addr;
    }));
    await check("minWager()",               () => gmbl.minWager().then(v => v.toString()));
    await check("maxWager()",               () => gmbl.maxWager().then(v => v.toString()));
  } else {
    console.log("\n[4] Gamble — skipped (GAMBLE_ADDRESS not set)");
  }

  // ── 5. Tournament ──────────────────────────────────────────────────────────
  if (cfg.tournament) {
    console.log("\n[5] Tournament");
    const tourn = new hre.ethers.Contract(cfg.tournament, TOURNAMENT_ABI, p);
    await check("bytecode deployed",     () => p.getCode(cfg.tournament).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
    await check("owner()",               () => tourn.owner());
    await check("membersOnly() correct", () => tourn.membersOnly().then(addr => {
      if (addr.toLowerCase() !== cfg.membersOnly.toLowerCase()) throw new Error(`points to ${addr}`);
      return "correct";
    }));
    await check("nextTournamentId()",    () => tourn.nextTournamentId().then(v => v.toString()));
  } else {
    console.log("\n[5] Tournament — skipped (TOURNAMENT_ADDRESS not set)");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("VALIDATION FAILED — review errors above");
    console.log("════════════════════════════════════════════════════════\n");
    process.exit(1);
  } else {
    console.log("All checks passed.");
    console.log("════════════════════════════════════════════════════════\n");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
