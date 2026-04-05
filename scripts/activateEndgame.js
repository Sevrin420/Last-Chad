/**
 * activateEndgame.js
 *
 * IRREVERSIBLE — Run after cull is complete:
 * 1. Freeze levels permanently on LastChad
 * 2. Read closed cells for all alive chads
 * 3. Snapshot endgame on Tournament contract
 * 4. Set cell tier brackets
 *
 * Usage:
 *   npx hardhat run scripts/activateEndgame.js --network avalanche
 */

const hre = require("hardhat");
const { LAST_CHAD, TOURNAMENT } = require('./addresses');

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("\n════════════════════════════════════════════");
  console.log("ACTIVATE ENDGAME (IRREVERSIBLE)");
  console.log("════════════════════════════════════════════");
  console.log(`Network:  ${hre.network.name}`);
  console.log(`Caller:   ${deployer.address}\n`);

  const lastChad = await hre.ethers.getContractAt('LastChad', LAST_CHAD, deployer);
  const tournament = await hre.ethers.getContractAt('Tournament', TOURNAMENT, deployer);

  // 1. Freeze levels
  console.log("1. Freezing levels...");
  let tx = await lastChad.freezeLevels();
  await tx.wait();
  console.log("   ✓ Levels frozen permanently");

  // 2. Read all alive chads and their closed cells
  console.log("\n2. Reading alive chads...");
  const totalMinted = await lastChad.totalMinted();
  const aliveIds = [];
  const aliveCells = [];

  for (let i = 1n; i <= totalMinted; i++) {
    const isEliminated = await lastChad.eliminated(i);
    if (!isEliminated) {
      const closedCells = await lastChad.getClosedCells(i);
      aliveIds.push(i);
      aliveCells.push(closedCells);
      console.log(`   Chad #${i}: ${closedCells} closed cells`);
    }
  }
  console.log(`   Found ${aliveIds.length} alive chads`);

  // 3. Snapshot endgame (batch in groups of 50)
  console.log("\n3. Snapshotting endgame...");
  const BATCH = 50;
  for (let i = 0; i < aliveIds.length; i += BATCH) {
    const idBatch = aliveIds.slice(i, i + BATCH);
    const cellBatch = aliveCells.slice(i, i + BATCH);
    tx = await tournament.snapshotEndgame(idBatch, cellBatch);
    await tx.wait();
    console.log(`   Batch ${Math.floor(i / BATCH) + 1}: chads ${i + 1}–${Math.min(i + BATCH, aliveIds.length)} ✓`);
  }

  // 4. Set cell tier brackets
  // These are default tiers — owner can adjust via setCellTier() later
  console.log("\n4. Setting cell tier brackets...");
  const thresholds = [100, 250, 500, 750, 1000, 1500, 2000];
  const amounts    = [10,  20,  30,  40,  50,   75,   100];
  tx = await tournament.batchSetCellTiers(thresholds, amounts);
  await tx.wait();
  console.log("   ✓ 7 tiers set:");
  for (let i = 0; i < thresholds.length; i++) {
    console.log(`     ${thresholds[i]}+ closed cells → ${amounts[i]} cells/month`);
  }

  console.log("\n════════════════════════════════════════════");
  console.log("Endgame activated. Levels frozen. Tournament ready.");
  console.log("════════════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
