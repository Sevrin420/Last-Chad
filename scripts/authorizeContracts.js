/**
 * authorizeContracts.js
 *
 * Authorizes the deployed QuestRewards contract in both LastChad and
 * LastChadItems by calling setGameContract(questRewardsAddress, true).
 *
 * Run this after deploying a new QuestRewards contract.
 *
 * Usage:
 *   npx hardhat run scripts/authorizeContracts.js --network fuji
 *   npx hardhat run scripts/authorizeContracts.js --network avalanche
 *
 * Required env vars:
 *   PRIVATE_KEY — owner wallet private key (hex, no 0x prefix)
 */

const hre = require("hardhat");

const LAST_CHAD_ADDRESS       = '0x27732900f9a87ced6a2ec5ce890d7ff58f882f76';
const LAST_CHAD_ITEMS_ADDRESS = '0x0ef84248f58be2ac72b8d2e4229fc4e8575d5947';
const QUEST_REWARDS_ADDRESS   = '0x72eD8376C35fA741Ac1D785E09DA5d94a808F136';

const SET_GAME_CONTRACT_ABI = [
  'function setGameContract(address gameContract, bool approved) external',
];

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nAuthorizing QuestRewards on [${network}]`);
  console.log(`Owner:         ${owner.address}`);
  console.log(`LastChad:      ${LAST_CHAD_ADDRESS}`);
  console.log(`LastChadItems: ${LAST_CHAD_ITEMS_ADDRESS}`);
  console.log(`QuestRewards:  ${QUEST_REWARDS_ADDRESS}\n`);

  const lastChad = new hre.ethers.Contract(
    LAST_CHAD_ADDRESS, SET_GAME_CONTRACT_ABI, owner
  );
  const lastChadItems = new hre.ethers.Contract(
    LAST_CHAD_ITEMS_ADDRESS, SET_GAME_CONTRACT_ABI, owner
  );

  console.log("Authorizing in LastChad...");
  let tx = await lastChad.setGameContract(QUEST_REWARDS_ADDRESS, true);
  await tx.wait();
  console.log("  lastChad.setGameContract ✓");

  console.log("Authorizing in LastChadItems...");
  tx = await lastChadItems.setGameContract(QUEST_REWARDS_ADDRESS, true);
  await tx.wait();
  console.log("  lastChadItems.setGameContract ✓");

  console.log("\nDone. QuestRewards is authorized on both contracts.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
