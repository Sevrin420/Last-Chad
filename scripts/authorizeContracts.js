/**
 * authorizeContracts.js
 *
 * Authorizes Gamble and Tournament contracts in both MembersOnly and
 * MembersOnlyItems by calling setGameContract(address, true).
 *
 * Run this after deploying new contracts.
 *
 * Usage:
 *   npx hardhat run scripts/authorizeContracts.js --network fuji
 *   npx hardhat run scripts/authorizeContracts.js --network avalanche
 *
 * Required env vars:
 *   PRIVATE_KEY — owner wallet private key (hex, no 0x prefix)
 */

const hre = require("hardhat");
const { MEMBERS_ONLY, ITEMS, GAMBLE, TOURNAMENT } = require('./addresses');

const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nAuthorizing game contracts on [${network}]`);
  console.log(`Owner:          ${owner.address}`);
  console.log(`MembersOnly:    ${MEMBERS_ONLY}`);
  console.log(`MembersOnlyItems: ${ITEMS}`);
  console.log(`Gamble:         ${GAMBLE}`);
  console.log(`Tournament:     ${TOURNAMENT}\n`);

  const membersOnly = new hre.ethers.Contract(MEMBERS_ONLY, SET_GAME_CONTRACT_ABI, owner);
  const items       = new hre.ethers.Contract(ITEMS, SET_GAME_CONTRACT_ABI, owner);

  const contracts = [
    { name: 'Gamble', address: GAMBLE },
    { name: 'Tournament', address: TOURNAMENT },
  ].filter(c => c.address);

  for (const c of contracts) {
    console.log(`Authorizing ${c.name} in MembersOnly...`);
    let tx = await membersOnly.setGameContract(c.address, true);
    await tx.wait();
    console.log(`  setGameContract(${c.name}) on MembersOnly ✓`);

    console.log(`Authorizing ${c.name} in MembersOnlyItems...`);
    tx = await items.setGameContract(c.address, true);
    await tx.wait();
    console.log(`  setGameContract(${c.name}) on MembersOnlyItems ✓`);
  }

  console.log("\nDone. All contracts authorized.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
