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

const LAST_CHAD_ADDRESS       = '0xcE6D7bC4cAdfafc4cAe6BB86fD70ea206bDe884f';
const LAST_CHAD_ITEMS_ADDRESS = '0x00906C5b4a5943E212FD59d227e995F3390cf86d';
const QUEST_REWARDS_ADDRESS   = '0x0CcA830784D13F4E9B606F914eB0c1deecA925eB';

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
