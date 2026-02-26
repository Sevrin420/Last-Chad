const hre = require("hardhat");

async function main() {
  const lastChadAddress = '0xE6A490A8D7fd9AAa70d095CC3e28a4974f9AfcE2';

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
