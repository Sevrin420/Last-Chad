/**
 * tournamentPayout.js
 *
 * Reads locked chads for the current month, logs the prize pool,
 * then calls Tournament.distributeAndReset() to send AVAX and advance month.
 *
 * Usage:
 *   npx hardhat run scripts/tournamentPayout.js --network avalanche
 */

const hre = require("hardhat");
const { TOURNAMENT } = require('./addresses');

async function main() {
  if (!TOURNAMENT || !hre.ethers.isAddress(TOURNAMENT)) {
    throw new Error("TOURNAMENT address not set in js/config.js — deploy Tournament first");
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("\n════════════════════════════════════════════");
  console.log("Tournament Payout");
  console.log("════════════════════════════════════════════");
  console.log(`Network:  ${hre.network.name}`);
  console.log(`Caller:   ${deployer.address}\n`);

  const tournament = await hre.ethers.getContractAt('Tournament', TOURNAMENT, deployer);

  const currentMonth = await tournament.currentMonth();
  const lockCount = await tournament.getLockCount(currentMonth);
  const lockedChads = await tournament.getLockedChads(currentMonth);
  const balance = await hre.ethers.provider.getBalance(TOURNAMENT);

  console.log(`Current Month:  ${currentMonth}`);
  console.log(`Lock Count:     ${lockCount}`);
  console.log(`Prize Pool:     ${hre.ethers.formatEther(balance)} AVAX`);
  console.log(`Locked Chads:   [${lockedChads.join(', ')}]`);

  if (lockCount > 0n && balance > 0n) {
    const perWinner = balance / lockCount;
    console.log(`Per Winner:     ${hre.ethers.formatEther(perWinner)} AVAX`);
  }

  console.log("\nDistributing and resetting...");
  const tx = await tournament.distributeAndReset();
  const receipt = await tx.wait();
  console.log(`  tx: ${tx.hash}`);
  console.log(`  gas: ${receipt.gasUsed}`);

  const newMonth = await tournament.currentMonth();
  console.log(`\nDone. Advanced to month ${newMonth}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
