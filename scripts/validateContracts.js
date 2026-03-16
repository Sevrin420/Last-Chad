/**
 * validateContracts.js
 *
 * Read-only on-chain validation for all deployed Last Chad contracts.
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
    lastChad:     get("CONTRACT_ADDRESS"),
    items:        get("ITEMS_CONTRACT_ADDRESS"),
    questRewards: get("QUEST_REWARDS_ADDRESS"),
    market:       get("MARKET_ADDRESS",   false),
    gamble:       get("GAMBLE_ADDRESS",   false),
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

const LAST_CHAD_ABI = [
  'function totalSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function name() view returns (string)',
  'function authorizedGame(address) view returns (bool)',
  'function owner() view returns (address)',
];

const ITEMS_ABI = [
  'function name() view returns (string)',
  'function getItem(uint256 itemId) view returns (string name, uint256 maxSupply, uint256 minted, uint256 price, bool stackable, bool active)',
  'function authorizedGame(address) view returns (bool)',
  'function owner() view returns (address)',
];

const QUEST_REWARDS_ABI = [
  'function lastChad() view returns (address)',
  'function getLockedCount() view returns (uint256)',
  'function gameOwner() view returns (address)',
];

const MARKET_ABI = [
  'function feeBps() view returns (uint256)',
  'function owner() view returns (address)',
];

const GAMBLE_ABI = [
  'function lastChad() view returns (address)',
  'function oracle() view returns (address)',
  'function minWager() view returns (uint256)',
  'function maxWager() view returns (uint256)',
  'function owner() view returns (address)',
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const network = hre.network.name;
  const cfg     = readConfig();
  const p       = hre.ethers.provider;

  console.log("\n════════════════════════════════════════════════════════");
  console.log("Last Chad — On-Chain Contract Validation");
  console.log("════════════════════════════════════════════════════════");
  console.log(`Network:       ${network}`);
  console.log(`LastChad:      ${cfg.lastChad}`);
  console.log(`Items:         ${cfg.items}`);
  console.log(`QuestRewards:  ${cfg.questRewards}`);
  if (cfg.market) console.log(`Market:        ${cfg.market}`);
  if (cfg.gamble) console.log(`Gamble:        ${cfg.gamble}`);
  console.log("────────────────────────────────────────────────────────");

  // ── 1. LastChad ────────────────────────────────────────────────────────────
  console.log("\n[1/5] LastChad");
  const lc = new hre.ethers.Contract(cfg.lastChad, LAST_CHAD_ABI, p);
  await check("bytecode deployed",       () => p.getCode(cfg.lastChad).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
  await check("name()",                  () => lc.name());
  await check("MAX_SUPPLY()",            () => lc.MAX_SUPPLY().then(v => v.toString()));
  await check("totalSupply()",           () => lc.totalSupply().then(v => v.toString()));
  await check("owner()",                 () => lc.owner());
  await check("QuestRewards authorized", () => lc.authorizedGame(cfg.questRewards).then(v => { if (!v) throw new Error("NOT authorized"); return "yes"; }));

  // ── 2. LastChadItems ───────────────────────────────────────────────────────
  console.log("\n[2/5] LastChadItems");
  const items = new hre.ethers.Contract(cfg.items, ITEMS_ABI, p);
  await check("bytecode deployed",       () => p.getCode(cfg.items).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
  await check("name()",                  () => items.name());
  await check("owner()",                 () => items.owner());
  await check("QuestRewards authorized", () => items.authorizedGame(cfg.questRewards).then(v => { if (!v) throw new Error("NOT authorized"); return "yes"; }));
  await check("Item #1 exists (name)",   () => items.getItem(1).then(r => r.name));
  await check("Item #1 active",          () => items.getItem(1).then(r => { if (!r.active) throw new Error("item inactive"); return "yes"; }));

  // ── 3. QuestRewards ────────────────────────────────────────────────────────
  console.log("\n[3/5] QuestRewards");
  const qr = new hre.ethers.Contract(cfg.questRewards, QUEST_REWARDS_ABI, p);
  await check("bytecode deployed",       () => p.getCode(cfg.questRewards).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
  await check("gameOwner()",             () => qr.gameOwner());
  await check("lastChad() points to LC", () => qr.lastChad().then(addr => {
    if (addr.toLowerCase() !== cfg.lastChad.toLowerCase()) throw new Error(`points to ${addr}`);
    return "correct";
  }));
  await check("getLockedCount()",        () => qr.getLockedCount().then(v => `${v.toString()} NFTs in escrow`));

  // ── 4. Market ──────────────────────────────────────────────────────────────
  if (cfg.market) {
    console.log("\n[4/5] Market");
    const mkt = new hre.ethers.Contract(cfg.market, MARKET_ABI, p);
    await check("bytecode deployed", () => p.getCode(cfg.market).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
    await check("owner()",           () => mkt.owner());
    await check("feeBps()",          () => mkt.feeBps().then(v => `${v.toString()} bps`));
  } else {
    console.log("\n[4/5] Market — skipped (MARKET_ADDRESS not set)");
  }

  // ── 5. Gamble ──────────────────────────────────────────────────────────────
  if (cfg.gamble) {
    console.log("\n[5/5] Gamble");
    const gmbl = new hre.ethers.Contract(cfg.gamble, GAMBLE_ABI, p);
    await check("bytecode deployed",       () => p.getCode(cfg.gamble).then(c => { if (c === "0x") throw new Error("no bytecode"); return "yes"; }));
    await check("owner()",                 () => gmbl.owner());
    await check("lastChad() points to LC", () => gmbl.lastChad().then(addr => {
      if (addr.toLowerCase() !== cfg.lastChad.toLowerCase()) throw new Error(`points to ${addr}`);
      return "correct";
    }));
    await check("oracle() is set",         () => gmbl.oracle().then(addr => {
      if (addr === "0x0000000000000000000000000000000000000000") throw new Error("oracle not set");
      return addr;
    }));
    await check("minWager()",              () => gmbl.minWager().then(v => v.toString()));
    await check("maxWager()",              () => gmbl.maxWager().then(v => v.toString()));
  } else {
    console.log("\n[5/5] Gamble — skipped (GAMBLE_ADDRESS not set)");
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
