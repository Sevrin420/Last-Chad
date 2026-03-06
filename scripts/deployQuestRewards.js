const hre = require("hardhat");

async function main() {
  const lastChadAddress = '0x27732900f9a87ced6a2ec5ce890d7ff58f882f76';

  const QuestRewards = await hre.ethers.getContractFactory("QuestRewards");
  const questRewards = await QuestRewards.deploy(lastChadAddress);
  await questRewards.waitForDeployment();

  const address = await questRewards.getAddress();
  console.log("QuestRewards deployed to:", address);
  console.log("Linked to LastChad:", lastChadAddress);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Set QUEST_REWARDS_ADDRESS =", `'${address}'`, "in js/config.js");
  console.log("  2. Authorize QuestRewards in LastChad:");
  console.log(`     lastChad.setGameContract('${address}', true)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
